import * as vscode from 'vscode';
import type { EstimateViewState } from '../estimateSession';
import {
  buildStatusBarPresentation,
  type PresentationContext,
} from './presentation';

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      10,
    );
    this.item.name = 'TokenLens';
    this.item.command = 'tokenlens.showActions';
    this.item.show();
  }

  public render(state: EstimateViewState, context: PresentationContext): void {
    const presentation = buildStatusBarPresentation(state, context);
    this.item.text = presentation.text;
    this.item.accessibilityInformation = {
      label: presentation.accessibilityLabel,
      role: 'button',
    };

    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = false;
    tooltip.supportHtml = false;
    presentation.tooltipParagraphs.forEach((paragraph, index) => {
      tooltip.appendText(paragraph);
      if (index < presentation.tooltipParagraphs.length - 1) {
        tooltip.appendMarkdown('\n\n');
      }
    });
    this.item.tooltip = tooltip;

    this.item.backgroundColor =
      presentation.emphasis === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : presentation.emphasis === 'error'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : undefined;
  }

  public dispose(): void {
    this.item.dispose();
  }
}
