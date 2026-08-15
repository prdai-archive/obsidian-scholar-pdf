import { Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';

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
}

const ENTRY_REGEX = /> \[!scholar-annotation\][^\n]*\n(?:>[^\n]*\n)*\^(\S+)/g;

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
            'tags: [scholar-annotations]',
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

    async addAnnotationFromSelection(comment: string): Promise<boolean> {
        const variables = this.plugin.lib.copyLink.getTemplateVariables({});
        if (!variables || !variables.text) {
            new Notice(`${this.plugin.manifest.name}: select text in a PDF first`);
            return false;
        }
        const { file, subpath, page, pageLabel, text } = variables;

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
        return true;
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

export class ScholarCommentModal extends Modal {
    comment = '';
    onSubmit: (comment: string) => void;

    constructor(plugin: PDFPlus, public highlightText: string, onSubmit: (comment: string) => void) {
        super(plugin.app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('div', { text: this.highlightText, cls: 'scholar-modal-highlight' });

        const textarea = contentEl.createEl('textarea', {
            cls: 'scholar-modal-comment',
            attr: { placeholder: 'Add a comment (optional)…', rows: '4' },
        });
        textarea.focus();
        textarea.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter' && (evt.ctrlKey || evt.metaKey)) {
                evt.preventDefault();
                this.submit(textarea.value);
            }
        });

        new Setting(contentEl)
            .addButton((button) => button
                .setButtonText('Annotate')
                .setCta()
                .onClick(() => this.submit(textarea.value)))
            .addButton((button) => button
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    submit(comment: string) {
        this.comment = comment;
        this.close();
        this.onSubmit(comment);
    }

    onClose() {
        this.contentEl.empty();
    }
}
