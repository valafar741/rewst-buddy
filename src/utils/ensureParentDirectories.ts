import { log } from './log';
import path from 'path';
import vscode from 'vscode';

/**
 * Create parent directories of a file URI up to (but not including) the workspace folder root.
 */
export async function ensureParentDirectories(fileUri: vscode.Uri): Promise<void> {
	if (fileUri.scheme !== 'file') {
		throw log.error('ensureParentDirectories: only file: URIs are supported');
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
	if (!workspaceFolder) {
		throw log.error('ensureParentDirectories: path must be inside a workspace folder');
	}

	const rootPath = workspaceFolder.uri.fsPath;
	const parentPath = path.dirname(fileUri.fsPath);

	if (parentPath.length < rootPath.length || !parentPath.startsWith(rootPath)) {
		throw log.error('ensureParentDirectories: parent path escapes workspace folder');
	}

	if (parentPath === rootPath) {
		return;
	}

	const dirsBottomUp: string[] = [];
	let current = parentPath;
	while (current !== rootPath && current.length > rootPath.length) {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(current));
			break;
		} catch {
			dirsBottomUp.push(current);
			current = path.dirname(current);
		}
	}

	const dirsTopDown = dirsBottomUp.reverse();
	for (const d of dirsTopDown) {
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(d));
	}
}
