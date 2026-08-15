import { ItemView, MarkdownRenderer, TFile, WorkspaceLeaf, setIcon } from 'obsidian';

import PDFPlus from 'main';
import { ScholarAnnotation } from './annotations';

export const SCHOLAR_VIEW_TYPE = 'scholar-annotations';

/**
 * Native sidebar listing annotation cards for the active PDF,
 * styled after the hypothes.is sidebar from the Annotator plugin.
 */
export class ScholarAnnotationsView extends ItemView {
    currentPdf: TFile | null = null;
    cardEls = new Map<string, HTMLElement>();
    /** Subpath of the card whose inline comment editor should open on next render. */
    pendingCommentSubpath: string | null = null;

    startInlineComment(subpath: string, attempt = 0) {
        this.pendingCommentSubpath = subpath;
        if (!this.cardEls.has(subpath)) {
            // wait for the card to be rendered (file modify event triggers render)
            if (attempt < 5) activeWindow.setTimeout(() => this.startInlineComment(subpath, attempt + 1), 200);
            return;
        }
        this.render();
    }

    flashCard(subpath: string, attempt = 0) {
        let target = this.cardEls.get(subpath);
        if (!target) {
            try { target = this.cardEls.get(decodeURIComponent(subpath)); } catch { /* malformed URI */ }
        }
        if (!target) {
            // the sidebar may still be rendering (e.g. it was just opened)
            if (attempt < 5) activeWindow.setTimeout(() => this.flashCard(subpath, attempt + 1), 200);
            return;
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

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
        this.cardEls.clear();
        container.addClass('scholar-sidebar');

        const header = container.createDiv('scholar-sidebar-header');
        const title = header.createDiv('scholar-sidebar-title');

        if (!this.currentPdf) {
            title.setText('No PDF open');
            container.createDiv({ cls: 'scholar-sidebar-empty', text: 'Open a PDF to see its annotations.' });
            return;
        }

        title.setText(this.currentPdf.basename);

        const result = await this.plugin.scholar.parseAnnotations(this.currentPdf);

        if (!result || result.annotations.length === 0) {
            container.createDiv({ cls: 'scholar-sidebar-empty', text: 'No annotations yet. Select text in the PDF and hit "Annotate selection".' });
            return;
        }

        const searchInput = header.createEl('input', {
            cls: 'scholar-sidebar-search',
            attr: { type: 'search', placeholder: 'Filter annotations…' },
        });
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase();
            for (const annotation of result.annotations) {
                const card = this.cardEls.get(annotation.subpath);
                if (!card) continue;
                const haystack = `${annotation.text} ${annotation.comment} ${annotation.color ?? ''} p.${annotation.pageLabel}`.toLowerCase();
                card.toggleClass('is-hidden-by-filter', !!query && !haystack.includes(query));
            }
        });

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
        this.cardEls.set(annotation.subpath, card);
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

        const isPending = this.pendingCommentSubpath === annotation.subpath;
        if (isPending) {
            this.pendingCommentSubpath = null;
            this.renderInlineCommentEditor(card, annotation);
        } else if (annotation.comment) {
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
            this.pendingCommentSubpath = annotation.subpath;
            this.render();
        });
        addAction('lucide-trash-2', 'Delete', async () => {
            if (this.currentPdf) await this.plugin.scholar.deleteAnnotation(this.currentPdf, annotation.id);
        }, 'scholar-card-delete');
    }

    renderInlineCommentEditor(card: HTMLElement, annotation: ScholarAnnotation) {
        const editor = card.createDiv('scholar-card-comment-editor');
        const textarea = editor.createEl('textarea', {
            attr: { placeholder: 'Add a comment… (Enter to save, Esc to cancel)', rows: '2' },
        });
        textarea.value = annotation.comment;

        const save = async () => {
            if (!this.currentPdf) return;
            const comment = textarea.value.trim();
            if (comment !== annotation.comment) {
                await this.plugin.scholar.updateComment(this.currentPdf, annotation, comment);
            } else {
                this.render();
            }
        };

        textarea.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter' && !evt.shiftKey) {
                evt.preventDefault();
                save();
            } else if (evt.key === 'Escape') {
                evt.preventDefault();
                this.render();
            }
        });
        textarea.addEventListener('blur', () => save());

        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        activeWindow.setTimeout(() => textarea.focus(), 0);
    }

    jumpTo(annotation: ScholarAnnotation) {
        if (!this.currentPdf) return;
        const linktext = this.app.metadataCache.fileToLinktext(this.currentPdf, '') + annotation.subpath;
        this.app.workspace.openLinkText(linktext, '', false);
    }
}
