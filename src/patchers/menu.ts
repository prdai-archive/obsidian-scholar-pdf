import { Menu } from 'obsidian';
import { around } from 'monkey-around';

import PDFPlus from 'main';


export const patchMenu = (plugin: PDFPlus) => {
    plugin.register(around(Menu.prototype, {
        showAtPosition(old) {
            return function (this: Menu, ...args: any[]) {
                if (this.parentEl?.closest('div.pdf-toolbar')) {
                    if (plugin.settings.hoverableDropdownMenuInToolbar) {
                        this.setUseNativeMenu(false);
                    }
                    // hide the "Thumbnails" sidebar option: this plugin treats the
                    // nested table of contents as the only sidebar view
                    const items = (this as any).items as any[] | undefined;
                    if (items) {
                        for (const item of items.slice()) {
                            if (item?.titleEl?.textContent === 'Thumbnails') {
                                item.dom?.detach();
                                items.splice(items.indexOf(item), 1);
                            }
                        }
                    }
                }
                plugin.shownMenus.add(this);
                return old.call(this, ...args);
            };
        },
        hide(old) {
            return function (this: Menu, ...args: any[]) {
                plugin.shownMenus.delete(this);
                return old.call(this, ...args);
            };
        }
    }));
};
