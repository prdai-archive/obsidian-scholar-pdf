import { Notice, TFile, normalizePath } from 'obsidian';

import PDFPlus from 'main';

/**
 * Scholar annotations: one markdown file per PDF (in the configured annotation
 * folder), holding annotation "cards" as blockquote entries with block IDs,
 * inspired by the Annotator plugin's format but using PDF++'s page-accurate
 * selection links instead of character offsets.
 */

export interface ScholarAnnotation {
    id: string;
    page: number;
    pageLabel: string;
    text: string;
    comment: string;
    created: string;
    /** Full wikilink subpath into the PDF, e.g. `#page=3&selection=...` */
    subpath: string;
    /** Highlight color name, if one was picked. */
    color?: string;
}

const ENTRY_REGEX = /> \[!scholar-annotation\][^\n]*\n(?:>[^\n]*\n)*\^(\S+)/g;

export interface ScholarSelectionCapture {
    file: TFile;
    subpath: string;
    page: number;
    pageLabel: string;
    text: string;
}

export class ScholarAnnotations {
    constructor(public plugin: PDFPlus) { }

    get app() {
        return this.plugin.app;
    }

    annotationFilePath(pdf: TFile): string {
        const folder = this.plugin.settings.scholarAnnotationFolder || 'annotations';
        return normalizePath(`${folder}/${pdf.basename}.md`);
    }

    async getOrCreateAnnotationFile(pdf: TFile): Promise<TFile> {
        const path = this.annotationFilePath(pdf);
        const existing = this.app.vault.getFileByPath(path);
        if (existing) return existing;

        const pdfLink = this.app.metadataCache.fileToLinktext(pdf, '');
        const frontmatter = [
            '---',
            `annotation-target: "[[${pdfLink}]]"`,
            `title: "${pdf.basename.replace(/"/g, '\\"')}"`,
            `added: "${window.moment().format('YYYY-MM-DD')}"`,
            '---',
            '',
            `# Annotations for [[${pdfLink}]]`,
            '',
        ].join('\n');
        return await this.plugin.lib.write(path, frontmatter, false) as TFile;
    }

    generateId(): string {
        return Math.random().toString(36).slice(2, 11);
    }

    formatEntry(ann: ScholarAnnotation, pdf: TFile): string {
        const pdfLink = this.app.metadataCache.fileToLinktext(pdf, '');
        const lines = [
            `> [!scholar-annotation] p.${ann.pageLabel} · ${ann.created}`,
            `> ==${ann.text.replace(/\n/g, ' ')}==`,
            `> [[${pdfLink}${ann.subpath}|show in PDF]]`,
        ];
        if (ann.comment) {
            lines.push('> ');
            for (const commentLine of ann.comment.split('\n')) {
                lines.push(`> ${commentLine}`);
            }
        }
        lines.push(`^${ann.id}`);
        return '\n' + lines.join('\n') + '\n';
    }

    /**
     * Capture the current PDF text selection. Call this synchronously while the
     * selection is still alive (menu clicks and async gaps can collapse it,
     * which used to record 1-character highlight ranges).
     */
    captureSelection(): ScholarSelectionCapture | null {
        const lib = this.plugin.lib;
        const selection = activeWindow.getSelection();
        if (!selection || !selection.toString()) return null;

        // Use PDF++'s own range computation (based on Range, which is always
        // normalized start-before-end) instead of Obsidian's
        // getTextSelectionRangeStr, which returns a collapsed 1-character range
        // for backward (right-to-left) selections.
        const pageAndRange = lib.copyLink.getPageAndTextRangeFromSelection(selection);
        if (!pageAndRange || !pageAndRange.selection) return null;
        const { page, selection: range } = pageAndRange;

        const pageEl = lib.getPageElFromSelection(selection);
        if (!pageEl) return null;
        const child = lib.getPDFViewerChildAssociatedWithNode(pageEl);
        const file = child?.file;
        if (!file) return null;

        const subpath = `#page=${page}&selection=${range.beginIndex},${range.beginOffset},${range.endIndex},${range.endOffset}`;
        return {
            file,
            subpath,
            page,
            pageLabel: child.getPage(page).pageLabel ?? ('' + page),
            text: lib.toSingleLine(selection.toString()),
        };
    }

    async addAnnotationFromSelection(comment: string, color?: string, captured?: ScholarSelectionCapture | null): Promise<ScholarAnnotation | null> {
        const capture = captured ?? this.captureSelection();
        if (!capture) {
            new Notice(`${this.plugin.manifest.name}: select text in a PDF first`);
            return null;
        }
        const { file, page, pageLabel, text } = capture;
        const subpath = color ? `${capture.subpath}&color=${color.toLowerCase()}` : capture.subpath;

        const annotation: ScholarAnnotation = {
            id: this.generateId(),
            page,
            pageLabel,
            text,
            comment,
            created: window.moment().format('YYYY-MM-DD HH:mm'),
            subpath,
        };

        const annotationFile = await this.getOrCreateAnnotationFile(file);
        await this.app.vault.process(annotationFile, (data) => {
            return data.trimEnd() + '\n' + this.formatEntry(annotation, file);
        });

        new Notice(`Annotation saved to ${annotationFile.path}`);
        return annotation;
    }

    /** Replace an annotation's comment by rewriting its entry in place. */
    async updateComment(pdf: TFile, annotation: ScholarAnnotation, comment: string): Promise<void> {
        const path = this.annotationFilePath(pdf);
        const file = this.app.vault.getFileByPath(path);
        if (!file) return;
        const newEntry = this.formatEntry({ ...annotation, comment }, pdf);
        await this.app.vault.process(file, (data) => {
            const regex = new RegExp(`\\n?> \\[!scholar-annotation\\][^\\n]*\\n(?:>[^\\n]*\\n)*\\^${annotation.id}\\n?`);
            return regex.test(data) ? data.replace(regex, newEntry) : data.trimEnd() + '\n' + newEntry;
        });
    }

    async parseAnnotations(pdf: TFile): Promise<{ file: TFile, annotations: ScholarAnnotation[] } | null> {
        const path = this.annotationFilePath(pdf);
        const file = this.app.vault.getFileByPath(path);
        if (!file) return null;

        const content = await this.app.vault.cachedRead(file);
        const annotations: ScholarAnnotation[] = [];

        for (const match of content.matchAll(ENTRY_REGEX)) {
            const block = match[0];
            const id = match[1];
            const header = block.match(/\[!scholar-annotation\] p\.(\S+) · ([^\n]+)/);
            const highlight = block.match(/> ==([\s\S]*?)==/);
            const link = block.match(/> \[\[[^#\]]*(#[^|\]]+)\|show in PDF\]\]/);
            const commentLines: string[] = [];
            let inComment = false;
            for (const line of block.split('\n')) {
                if (line === '> ') { inComment = true; continue; }
                if (inComment && line.startsWith('> ')) commentLines.push(line.slice(2));
            }
            annotations.push({
                id,
                page: link ? +(link[1].match(/#page=(\d+)/)?.[1] ?? 0) : 0,
                pageLabel: header?.[1] ?? '?',
                created: header?.[2] ?? '',
                text: highlight?.[1] ?? '',
                comment: commentLines.join('\n'),
                subpath: link?.[1] ?? '',
                color: link?.[1].match(/&color=([^&\s]+)/)?.[1],
            });
        }

        return { file, annotations };
    }

    async deleteAnnotation(pdf: TFile, id: string): Promise<void> {
        const path = this.annotationFilePath(pdf);
        const file = this.app.vault.getFileByPath(path);
        if (!file) return;
        await this.app.vault.process(file, (data) => {
            const regex = new RegExp(`\\n?> \\[!scholar-annotation\\][^\\n]*\\n(?:>[^\\n]*\\n)*\\^${id}\\n?`);
            return data.replace(regex, '\n');
        });
    }
}

