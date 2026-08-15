import { ItemView, MarkdownRenderer, TFile, WorkspaceLeaf, setIcon } from 'obsidian';

import PDFPlus from 'main';
import { ScholarAnnotation, ScholarCommentModal } from './annotations';

export const SCHOLAR_VIEW_TYPE = 'scholar-annotations';

/**
 * Native sidebar listing annotation cards for the active PDF,
 * styled after the hypothes.is sidebar from the Annotator plugin.
 */
export class ScholarAnnotationsView extends ItemView {
    currentPdf: TFile | null = null;

    constructor(leaf: WorkspaceLeaf, public plugin: PDFPlus) {
        super(leaf);
    }

    getViewType() {
        return SCHOLAR_VIEW_TYPE;
    }

    getDisplayText() {
        return 'Annotations';
    }

    getIcon() {
        return 'highlighter';
    }

    async onOpen() {
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshFromActiveLeaf()));
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (this.currentPdf && file.path === this.plugin.scholar.annotationFilePath(this.currentPdf)) {
                this.render();
            }
        }));
        this.refreshFromActiveLeaf();
    }

    refreshFromActiveLeaf() {
        const pdf = this.findActivePdfFile();
        if (pdf && pdf !== this.currentPdf) {
            this.currentPdf = pdf;
            this.render();
        } else if (!this.currentPdf) {
            this.render();
        }
    }

    findActivePdfFile(): TFile | null {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile?.extension === 'pdf') return activeFile;
        // fall back to any visible PDF view
        for (const leaf of this.app.workspace.getLeavesOfType('pdf')) {
            const file = (leaf.view as any).file;
            if (file instanceof TFile) return file;
        }
        return null;
    }

    async render() {
        const container = this.contentEl;
        container.empty();
        container.addClass('scholar-sidebar');

        const header = container.createDiv('scholar-sidebar-header');
        const title = header.createDiv('scholar-sidebar-title');

        if (!this.currentPdf) {
            title.setText('No PDF open');
            container.createDiv({ cls: 'scholar-sidebar-empty', text: 'Open a PDF to see its annotations.' });
            return;
        }

        title.setText(this.currentPdf.basename);

        const annotateButton = header.createEl('button', { cls: 'scholar-annotate-button' });
        setIcon(annotateButton.createSpan(), 'highlighter');
        annotateButton.createSpan({ text: 'Annotate selection' });
        annotateButton.addEventListener('click', () => this.plugin.scholarAnnotateSelection());

        const result = await this.plugin.scholar.parseAnnotations(this.currentPdf);

        if (!result || result.annotations.length === 0) {
            container.createDiv({ cls: 'scholar-sidebar-empty', text: 'No annotations yet. Select text in the PDF and hit "Annotate selection".' });
            return;
        }

        const noteLink = container.createDiv('scholar-sidebar-notelink');
        const openNote = noteLink.createEl('a', { text: `Open annotation note (${result.annotations.length})` });
        openNote.addEventListener('click', () => {
            this.app.workspace.getLeaf('tab').openFile(result.file);
        });

        const list = container.createDiv('scholar-card-list');
        for (const annotation of result.annotations) {
            this.renderCard(list, annotation, result.file);
        }
    }

    highlightColorHex(annotation: ScholarAnnotation): string | null {
        if (!annotation.color) return null;
        for (const [name, hex] of Object.entries(this.plugin.settings.colors ?? {})) {
            if (name.toLowerCase() === annotation.color.toLowerCase()) return hex;
        }
        return null;
    }

    renderCard(parent: HTMLElement, annotation: ScholarAnnotation, annotationFile: TFile) {
        const card = parent.createDiv('scholar-card');
        const colorHex = this.highlightColorHex(annotation);
        if (colorHex) card.style.setProperty('--scholar-card-accent', colorHex);

        const meta = card.createDiv('scholar-card-meta');
        const page = meta.createSpan({ cls: 'scholar-card-page', text: `Page ${annotation.pageLabel}` });
        page.addEventListener('click', () => this.jumpTo(annotation));
        meta.createSpan({ cls: 'scholar-card-date', text: annotation.created.split(' ')[0] ?? annotation.created });

        const quote = card.createDiv('scholar-card-quote');
        quote.setText(annotation.text);
        quote.setAttribute('aria-label', 'Show in PDF');
        quote.addEventListener('click', () => this.jumpTo(annotation));

        if (annotation.comment) {
            const comment = card.createDiv('scholar-card-comment');
            MarkdownRenderer.render(this.app, annotation.comment, comment, annotationFile.path, this);
        }

        const actions = card.createDiv('scholar-card-actions');
        const addAction = (icon: string, label: string, onClick: () => void, cls?: string) => {
            const button = actions.createDiv({ cls: ['clickable-icon', 'scholar-card-action', ...(cls ? [cls] : [])] });
            setIcon(button, icon);
            button.setAttribute('aria-label', label);
            button.addEventListener('click', onClick);
        };

        addAction('lucide-locate-fixed', 'Show in PDF', () => this.jumpTo(annotation));
        addAction('lucide-pencil-line', 'Edit comment', () => {
            new ScholarCommentModal(this.plugin, annotation.text, async (comment) => {
                if (!this.currentPdf) return;
                await this.plugin.scholar.deleteAnnotation(this.currentPdf, annotation.id);
                const pdf = this.currentPdf;
                await this.app.vault.process(annotationFile, (data) => {
                    return data.trimEnd() + '\n' + this.plugin.scholar.formatEntry({ ...annotation, comment }, pdf);
                });
            }).open();
        });
        addAction('lucide-trash-2', 'Delete', async () => {
            if (this.currentPdf) await this.plugin.scholar.deleteAnnotation(this.currentPdf, annotation.id);
        }, 'scholar-card-delete');
    }

    jumpTo(annotation: ScholarAnnotation) {
        if (!this.currentPdf) return;
        const linktext = this.app.metadataCache.fileToLinktext(this.currentPdf, '') + annotation.subpath;
        this.app.workspace.openLinkText(linktext, '', false);
    }
}
