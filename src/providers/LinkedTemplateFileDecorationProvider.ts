import { LinkManager } from '@models';
import vscode from 'vscode';

const THEME_COLOR_ID = 'rewst-buddy.linkedTemplateExplorer';

/**
 * Explorer file decorations for workspace files linked to Rewst templates (badge + theme color).
 */
export class LinkedTemplateFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<undefined | vscode.Uri | vscode.Uri[]>();
	readonly onDidChangeFileDecorations = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [];
	private linkedUriSet: Set<string> | undefined;

	constructor() {
		this.disposables.push(
			LinkManager.onLinksSaved(() => {
				this.linkedUriSet = undefined;
				this.emitter.fire(undefined);
			}),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.emitter.dispose();
	}

	provideFileDecoration(uri: vscode.Uri, _token: vscode.CancellationToken): vscode.FileDecoration | undefined {
		if (uri.scheme !== 'file') {
			return undefined;
		}

		if (this.linkedUriSet === undefined) {
			this.linkedUriSet = new Set(LinkManager.getAllTemplateLinks().map(l => l.uriString));
		}

		if (!this.linkedUriSet.has(uri.toString())) {
			return undefined;
		}

		return new vscode.FileDecoration('🔗', 'Linked to Rewst template', new vscode.ThemeColor(THEME_COLOR_ID));
	}
}
