"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = __importStar(require("vscode"));
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const database_1 = require("./database");
function activate(context) {
    context.subscriptions.push(vscode.window.registerCustomEditorProvider("sqliteEditor.database", {
        async openCustomDocument(uri) {
            await validateDatabaseFile(uri);
            return { uri, dispose() { } };
        },
        resolveCustomEditor(document, panel) {
            panel.webview.options = { enableScripts: true };
            new Editor(panel, document.uri.fsPath);
        }
    }, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true
    }));
    context.subscriptions.push(vscode.commands.registerCommand("sqliteEditor.openDatabase", async (resource) => {
        try {
            const uri = resource ?? (await vscode.window.showOpenDialog({
                canSelectMany: false,
                canSelectFiles: true,
                openLabel: "Open SQLite database"
            }))?.[0];
            if (!uri)
                return;
            await validateDatabaseFile(uri);
            const panel = vscode.window.createWebviewPanel("sqliteEditor", `SQLite: ${uri.path.split("/").pop()}`, vscode.ViewColumn.One, {
                enableScripts: true,
                retainContextWhenHidden: true
            });
            new Editor(panel, uri.fsPath);
        }
        catch (error) {
            void vscode.window.showErrorMessage(`SQLite Editor: ${errorMessage(error)}`);
        }
    }));
}
async function validateDatabaseFile(uri) {
    if (uri.scheme !== "file" || !(await (0, promises_1.stat)(uri.fsPath)).isFile())
        throw new Error("Choose an existing local database file.");
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
class Editor {
    panel;
    path;
    objects = [];
    selected;
    page;
    offset = 0;
    busy = false;
    constructor(panel, path) {
        this.panel = panel;
        this.path = path;
        panel.webview.onDidReceiveMessage((message) => { void this.handle(message); });
        panel.webview.html = html();
    }
    get executable() {
        return vscode.workspace.getConfiguration("sqliteEditor").get("sqlitePath", "sqlite3");
    }
    async send() {
        await this.panel.webview.postMessage({
            type: "state",
            objects: this.objects,
            selected: this.selected?.name,
            offset: this.offset,
            hasMore: this.page?.hasMore ?? false,
            columns: this.page?.columns ?? [],
            rows: this.page?.rows.map(row => row.cells.map(cell => ({
                type: cell.type,
                value: (0, database_1.cellValue)(cell),
                editValue: cell.type === "blob" ? cell.hex : cell.type === "null" ? "" : (0, database_1.cellValue)(cell)
            }))) ?? [],
            editable: this.selected?.type === "table"
        });
    }
    async refresh() {
        try {
            this.objects = await (0, database_1.listObjects)(this.executable, this.path);
            this.selected = this.objects.find(object => object.name === this.selected?.name && object.type === this.selected?.type) ?? this.objects[0];
            if (!this.selected) {
                this.page = undefined;
            }
            else {
                this.page = await (0, database_1.readTable)(this.executable, this.path, this.selected, this.offset);
            }
            await this.send();
        }
        catch (error) {
            this.page = undefined;
            await this.send();
            void vscode.window.showErrorMessage(`SQLite Editor: ${errorMessage(error)}`);
        }
    }
    async handle(message) {
        if (this.busy || !message || typeof message !== "object" || !("type" in message))
            return;
        this.busy = true;
        const data = message;
        try {
            if (data.type === "ready") {
                await this.refresh();
            }
            else if (data.type === "select" && typeof data.name === "string") {
                this.selected = this.objects.find(object => object.name === data.name);
                this.offset = 0;
                await this.refresh();
            }
            else if (data.type === "page" && (data.direction === "next" || data.direction === "previous")) {
                if (data.direction === "next" && this.page?.hasMore)
                    this.offset += 100;
                if (data.direction === "previous")
                    this.offset = Math.max(0, this.offset - 100);
                await this.refresh();
            }
            else if (data.type === "refresh") {
                this.offset = 0;
                await this.refresh();
            }
            else if (data.type === "save") {
                if (typeof data.row !== "number" || !Number.isInteger(data.row) ||
                    typeof data.column !== "number" || !Number.isInteger(data.column) ||
                    !isStorageType(data.storageType) || typeof data.value !== "string") {
                    throw new Error("Invalid cell edit.");
                }
                await this.save(data.row, data.column, data.storageType, data.value);
            }
            else if (data.type === "paste") {
                if (!Array.isArray(data.edits) || !data.edits.length || !data.edits.every(isCellEdit)) {
                    throw new Error("Invalid pasted cell data.");
                }
                await this.saveMany(data.edits);
                await this.panel.webview.postMessage({ type: "pasteSaved", count: data.edits.length });
            }
            else if (data.type === "sql" && typeof data.sql === "string") {
                const confirm = await vscode.window.showWarningMessage("Run this SQL? It may permanently modify the database. Statements before an error may already have been applied.", { modal: true }, "Run SQL");
                if (confirm !== "Run SQL")
                    return;
                try {
                    const output = await (0, database_1.executeSql)(this.executable, this.path, data.sql);
                    await this.panel.webview.postMessage({ type: "result", output });
                }
                finally {
                    this.offset = 0;
                    await this.refresh();
                }
            }
        }
        catch (error) {
            if (data.type === "save") {
                await this.panel.webview.postMessage({ type: "saveError", message: errorMessage(error) });
            }
            else if (data.type === "paste") {
                await this.panel.webview.postMessage({ type: "pasteError", message: errorMessage(error) });
            }
            else {
                void vscode.window.showErrorMessage(`SQLite Editor: ${errorMessage(error)}`);
            }
        }
        finally {
            this.busy = false;
        }
    }
    async save(rowIndex, columnIndex, type, value) {
        const object = this.selected;
        const page = this.page;
        const column = page?.columns[columnIndex];
        const cell = page?.rows[rowIndex]?.cells[columnIndex];
        if (!object || object.type !== "table" || !page || !column || column.hidden !== 0 || !cell)
            throw new Error("This cell cannot be edited.");
        await (0, database_1.updateCell)(this.executable, this.path, object, page, rowIndex, columnIndex, type, value);
        await this.refresh();
    }
    async saveMany(edits) {
        const object = this.selected;
        const page = this.page;
        if (!object || !page)
            throw new Error("Select a table before pasting data.");
        await (0, database_1.updateCells)(this.executable, this.path, object, page, edits);
        await this.refresh();
    }
}
function isStorageType(type) {
    return type === "null" || type === "integer" || type === "real" || type === "text" || type === "blob";
}
function isCellEdit(edit) {
    if (!edit || typeof edit !== "object")
        return false;
    const value = edit;
    return typeof value.rowIndex === "number" && Number.isInteger(value.rowIndex) &&
        typeof value.columnIndex === "number" && Number.isInteger(value.columnIndex) &&
        isStorageType(value.type) && typeof value.value === "string";
}
function html() {
    const nonce = (0, node_crypto_1.randomBytes)(16).toString("base64");
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { padding: 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
button, select, textarea, input { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 6px; font: inherit; }
button { cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin: 3px; }
button:disabled { opacity: .5; cursor: default; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
select { min-width: 180px; }
.table-wrap { overflow: auto; max-height: 48vh; margin: 12px 0; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--vscode-panel-border); text-align: left; padding: 6px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--vscode-editor-background); }
td.editable { cursor: pointer; }
td.editable:hover { outline: 1px solid var(--vscode-focusBorder); }
td.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px solid var(--vscode-focusBorder); }
td.editing { min-width: 300px; overflow: visible; white-space: normal; }
.cell-editor { display: flex; align-items: center; gap: 3px; }
.cell-editor select { width: 82px; min-width: 0; padding: 4px; }
.cell-editor input { width: 100px; min-width: 0; padding: 4px; }
.cell-editor button { margin: 0; padding: 4px; }
.cell-error { color: var(--vscode-errorForeground); white-space: normal; }
.paste-status { min-height: 1.5em; color: var(--vscode-descriptionForeground); }
.paste-status.error { color: var(--vscode-errorForeground); }
textarea { display: block; width: 100%; box-sizing: border-box; min-height: 120px; font-family: var(--vscode-editor-font-family, monospace); }
pre { overflow: auto; white-space: pre; max-height: 35vh; }
</style></head><body>
<h2>SQLite Editor</h2>
<div class="bar"><label for="objects">Table or view</label><select id="objects"></select><button id="refresh">Refresh</button><button id="previous">Previous</button><span id="page"></span><button id="next">Next</button></div>
<p>Click or drag to select cells, then paste a value or tab/newline-separated data. Double-click a cell or press Enter to edit it. Views and generated columns are read-only.</p>
<div class="table-wrap"><table><thead id="head"></thead><tbody id="body"></tbody></table></div>
<div id="paste-status" class="paste-status" aria-live="polite"></div>
<h3>SQL</h3><textarea id="sql" aria-label="SQL query" spellcheck="false" placeholder="SELECT * FROM ...;"></textarea>
<button id="run">Run SQL</button><pre id="result" aria-live="polite"></pre>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const objects = document.getElementById('objects'), head = document.getElementById('head'), body = document.getElementById('body');
const pasteStatus = document.getElementById('paste-status');
const storageTypes = ['text', 'integer', 'real', 'blob', 'null'];
let state, editing, selection, dragging = false, dragged = false;
document.getElementById('refresh').onclick = () => vscode.postMessage({type:'refresh'});
document.getElementById('previous').onclick = () => vscode.postMessage({type:'page',direction:'previous'});
document.getElementById('next').onclick = () => vscode.postMessage({type:'page',direction:'next'});
document.getElementById('run').onclick = () => vscode.postMessage({type:'sql',sql:document.getElementById('sql').value});
objects.onchange = () => vscode.postMessage({type:'select',name:objects.value});
function cellAt(row, column) { return body.querySelector('td[data-row="' + row + '"][data-column="' + column + '"]'); }
function renderSelection() {
  for (const cell of body.querySelectorAll('td[data-row]')) {
    const row = Number(cell.dataset.row), column = Number(cell.dataset.column);
    const selected = selection && row >= Math.min(selection.anchorRow, selection.focusRow) &&
      row <= Math.max(selection.anchorRow, selection.focusRow) &&
      column >= Math.min(selection.anchorColumn, selection.focusColumn) &&
      column <= Math.max(selection.anchorColumn, selection.focusColumn);
    cell.classList.toggle('selected', Boolean(selected));
  }
}
function beginEdit(row, column, cell) {
  editing = {row,column,type:cell.type,value:cell.editValue,saving:false};
  renderTable();
}
function pasteText(text) {
  const lines = text.replace(/\\r\\n?/g, '\\n').split('\\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length || !selection) return;
  const values = lines.map(line => line.split('\\t'));
  const startRow = Math.min(selection.anchorRow, selection.focusRow);
  const startColumn = Math.min(selection.anchorColumn, selection.focusColumn);
  const edits = [];
  if (values.length === 1 && values[0].length === 1) {
    const value = values[0][0];
    for (let row = Math.min(selection.anchorRow, selection.focusRow); row <= Math.max(selection.anchorRow, selection.focusRow); row++) {
      for (let column = Math.min(selection.anchorColumn, selection.focusColumn); column <= Math.max(selection.anchorColumn, selection.focusColumn); column++) {
        edits.push({rowIndex:row,columnIndex:column,type:'text',value});
      }
    }
  } else {
    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        edits.push({rowIndex:startRow + r,columnIndex:startColumn + c,type:'text',value:values[r][c]});
      }
    }
  }
  if (!edits.length) return;
  if (!state.editable || edits.some(edit => edit.rowIndex >= state.rows.length || edit.columnIndex >= state.columns.length ||
      state.columns[edit.columnIndex].hidden !== 0)) {
    pasteStatus.textContent = 'Paste must fit within editable cells in the current table page.';
    pasteStatus.classList.add('error');
    return;
  }
  pasteStatus.textContent = 'Pasting...';
  pasteStatus.classList.remove('error');
  vscode.postMessage({type:'paste',edits});
}
function renderTable() {
  if (!state) return;
  head.replaceChildren(); body.replaceChildren();
  const header = document.createElement('tr');
  for (const column of state.columns) { const th = document.createElement('th'); th.textContent = column.name; header.append(th); }
  head.append(header);
  state.rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.forEach((cell, c) => {
      const td = document.createElement('td');
      td.dataset.row = r; td.dataset.column = c; td.tabIndex = 0;
      const isEditing = editing && editing.row === r && editing.column === c;
      if (isEditing) {
        td.className = 'editing';
        const editor = document.createElement('div'); editor.className = 'cell-editor';
        const type = document.createElement('select'); type.setAttribute('aria-label', 'Storage type');
        for (const storageType of storageTypes) {
          const option = document.createElement('option'); option.value = storageType; option.textContent = storageType.toUpperCase(); option.selected = storageType === editing.type; type.append(option);
        }
        const input = document.createElement('input'); input.type = 'text'; input.setAttribute('aria-label', 'Cell value');
        const updateInput = () => {
          input.value = editing.value;
          input.disabled = editing.type === 'null';
          input.placeholder = editing.type === 'blob' ? 'Hex bytes' : 'Value';
        };
        updateInput();
        type.onchange = () => {
          editing.type = type.value;
          editing.value = editing.type === cell.type ? cell.editValue : '';
          updateInput();
          error.textContent = '';
        };
        input.oninput = () => { editing.value = input.value; };
        const error = document.createElement('span'); error.className = 'cell-error'; error.setAttribute('role', 'alert');
        const save = document.createElement('button'); save.textContent = 'Save';
        const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
        const submit = () => {
          if (editing.saving) return;
          editing.saving = true;
          save.disabled = true; cancel.disabled = true; type.disabled = true; input.disabled = true;
          vscode.postMessage({type:'save',row:r,column:c,storageType:editing.type,value:editing.value});
        };
        save.onclick = submit;
        input.onkeydown = event => {
          if (event.key === 'Enter') { event.preventDefault(); submit(); }
          if (event.key === 'Escape' && !editing.saving) { editing = undefined; renderTable(); }
        };
        cancel.onclick = () => { editing = undefined; renderTable(); };
        editor.append(type, input, save, cancel);
        td.append(editor, error);
        input.focus();
      } else {
        td.textContent = cell.type === 'null' ? 'NULL' : cell.value;
        td.title = cell.type + ': ' + td.textContent;
        if (state.editable && state.columns[c].hidden === 0) {
          td.className = 'editable';
        }
        td.onmousedown = event => {
          if (event.button !== 0) return;
          dragging = true; dragged = false;
          if (event.shiftKey && selection) {
            selection.focusRow = r; selection.focusColumn = c;
          } else {
            selection = {anchorRow:r,anchorColumn:c,focusRow:r,focusColumn:c};
          }
          event.preventDefault();
          td.focus();
          renderSelection();
        };
        td.onmouseenter = () => {
          if (!dragging || !selection) return;
          if (selection.focusRow !== r || selection.focusColumn !== c) dragged = true;
          selection.focusRow = r; selection.focusColumn = c;
          renderSelection();
        };
        td.onclick = event => {
          if (dragged) { dragged = false; return; }
          if (event.shiftKey && selection) {
            selection.focusRow = r; selection.focusColumn = c;
          } else {
            selection = {anchorRow:r,anchorColumn:c,focusRow:r,focusColumn:c};
          }
          renderSelection();
        };
        td.ondblclick = () => { if (state.editable && state.columns[c].hidden === 0) beginEdit(r, c, cell); };
        td.onkeydown = event => {
          if ((event.key === 'Enter' || event.key === 'F2') && state.editable && state.columns[c].hidden === 0) {
            event.preventDefault(); beginEdit(r, c, cell); return;
          }
          if (!event.shiftKey || !selection || !event.key.startsWith('Arrow')) return;
          const nextRow = selection.focusRow + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0);
          const nextColumn = selection.focusColumn + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0);
          if (nextRow < 0 || nextRow >= state.rows.length || nextColumn < 0 || nextColumn >= state.columns.length) return;
          event.preventDefault();
          selection.focusRow = nextRow; selection.focusColumn = nextColumn;
          renderSelection(); cellAt(nextRow, nextColumn).focus();
        };
      }
      tr.append(td);
    });
    body.append(tr);
  });
  renderSelection();
}
document.addEventListener('mouseup', () => { dragging = false; });
body.addEventListener('paste', event => {
  if (!selection || editing) return;
  const text = event.clipboardData && event.clipboardData.getData('text/plain');
  if (text === null || text === undefined) return;
  event.preventDefault();
  pasteText(text);
});
window.addEventListener('message', event => {
  const data = event.data;
  if (data.type === 'result') { document.getElementById('result').textContent = data.output; return; }
  if (data.type === 'saveError') {
    if (editing) { editing.saving = false; renderTable(); body.querySelector('.cell-error').textContent = data.message; }
    return;
  }
  if (data.type === 'pasteSaved') {
    pasteStatus.textContent = 'Updated ' + data.count + ' cell' + (data.count === 1 ? '' : 's') + '.';
    pasteStatus.classList.remove('error');
    return;
  }
  if (data.type === 'pasteError') {
    pasteStatus.textContent = data.message;
    pasteStatus.classList.add('error');
    return;
  }
  if (data.type !== 'state') return;
  state = data;
  editing = undefined;
  selection = undefined;
  pasteStatus.textContent = '';
  pasteStatus.classList.remove('error');
  objects.replaceChildren();
  for (const object of data.objects) {
    const option = document.createElement('option'); option.value = object.name; option.textContent = object.name + ' (' + object.type + ')'; option.selected = object.name === data.selected; objects.append(option);
  }
  document.getElementById('previous').disabled = data.offset === 0;
  document.getElementById('next').disabled = !data.hasMore;
  document.getElementById('page').textContent = 'Rows ' + (data.rows.length ? data.offset + 1 : 0) + '-' + (data.offset + data.rows.length);
  renderTable();
});
vscode.postMessage({type:'ready'});
</script></body></html>`;
}
//# sourceMappingURL=extension.js.map