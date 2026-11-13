# SQLiter - SQLite Database Editor

A VS Code extension for opening a local SQLite database, browsing tables and views, editing cells, and running SQL.

## Requirements

- VS Code 1.85 or newer.
- The `sqlite3` command-line tool, available on your PATH. Alternatively, set `sqliteEditor.sqlitePath` to its executable path. The CLI must support `-safe` and JSON output.

## Use

Click a `.sqlite`, `.sqlite3`, or `.db` file in Explorer to open it in SQLite Editor. You can also right-click one of those files and select **SQLite Editor: Open Database**. For databases with other extensions, use **SQLite Editor: Open Database** from the Command Palette. The database must already exist. Automatic opening is based on the filename, not file contents; non-SQLite `.db` files will report an error. VS Code's editor associations can override the default editor. Password-protected databases and remote files are not supported.

Select a table or view to browse 100 rows at a time. Click or drag across cells to select them. Paste one value to fill the selected range, or paste tab/newline-separated data starting at the selection. Pasted values are treated as text, and SQLite column affinity may convert them. Paste is limited to editable cells on the current page and is applied as one atomic update. Double-click a cell or press Enter to edit it directly; choose its SQLite storage type, then select **Save** (or press Enter). Press Escape or select **Cancel** to discard the edit. Enter BLOBs as hexadecimal bytes. Generated columns and views are read-only. Edits are checked against the loaded row; refresh if another connection changed it. Tables without an accessible rowid can only be edited when the displayed row is unique.

Use the SQL area for inserts, deletes, schema changes, and queries. SQL executes directly against the database; make a backup before making changes. Multiple statements are allowed, but statements before an error may already have committed. Use explicit transactions when appropriate. SQLite CLI dot commands are not supported. Each operation uses a new connection, so temporary tables, connection settings, and open transactions do not persist between operations.

The SQLite CLI limits each operation to 30 seconds and 16 MiB of output. Large values or query results may exceed this limit. Paging uses SQLite's natural row order, which can change when data changes. Press **Refresh** to reload the schema and data.