"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listObjects = listObjects;
exports.readTable = readTable;
exports.cellValue = cellValue;
exports.valueExpression = valueExpression;
exports.updateCells = updateCells;
exports.updateCell = updateCell;
exports.executeSql = executeSql;
const node_child_process_1 = require("node:child_process");
const node_os_1 = require("node:os");
const node_url_1 = require("node:url");
function identifier(name) {
    return `"${name.replace(/"/g, '""')}"`;
}
function run(executable, database, sql, readonly = false, json = true) {
    const uri = (0, node_url_1.pathToFileURL)(database).href + (readonly ? "?mode=ro" : "?mode=rw");
    const args = ["-batch", "-bail", "-safe", "-init", node_os_1.devNull, "-cmd", ".timeout 5000", json ? "-json" : "-box", "--", uri];
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.execFile)(executable, args, { maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
            }
            else {
                resolve(stdout);
            }
        });
        child.stdin?.end(sql + "\n");
    });
}
async function query(executable, database, sql) {
    const result = await run(executable, database, sql, true);
    return result.trim() ? JSON.parse(result) : [];
}
async function listObjects(executable, database) {
    return query(executable, database, "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name;");
}
async function readTable(executable, database, object, offset) {
    if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error("Invalid page offset.");
    const allColumns = await query(executable, database, `SELECT name, hidden FROM pragma_table_xinfo(${literalText(object.name)}) ORDER BY cid;`);
    const columns = allColumns.filter(column => column.hidden !== 1);
    if (!columns.length)
        throw new Error("The table or view no longer exists or has no visible columns.");
    const encodings = await query(executable, database, "PRAGMA encoding;");
    const encoding = encodings[0]?.encoding;
    if (!encoding || !["UTF-8", "UTF-16le", "UTF-16be"].includes(encoding))
        throw new Error(`Unsupported database text encoding: ${encoding ?? "unknown"}.`);
    let rowidAlias;
    if (object.type === "table") {
        const names = new Set(allColumns.map(column => column.name.toLowerCase()));
        const candidate = ["rowid", "_rowid_", "oid"].find(name => !names.has(name));
        if (candidate) {
            try {
                await query(executable, database, `SELECT ${candidate} FROM ${identifier(object.name)} LIMIT 0;`);
                rowidAlias = candidate;
            }
            catch (error) {
                if (!(error instanceof Error) || !error.message.includes(`no such column: ${candidate}`))
                    throw error;
            }
        }
    }
    const expressions = columns.flatMap((column, i) => [
        `typeof(${identifier(column.name)}) AS t${i}`,
        `hex(CAST(${identifier(column.name)} AS BLOB)) AS v${i}`,
        `CASE WHEN typeof(${identifier(column.name)}) = 'real' THEN quote(${identifier(column.name)}) END AS q${i}`
    ]);
    if (rowidAlias)
        expressions.push(`CAST(${rowidAlias} AS TEXT) AS __rowid`);
    const raw = await query(executable, database, `SELECT ${expressions.join(", ")} FROM ${identifier(object.name)} LIMIT 101 OFFSET ${offset};`);
    const rows = raw.slice(0, 100).map(row => {
        const cells = columns.map((_, i) => ({ type: row[`t${i}`], hex: row[`v${i}`] ?? "", encoding, realQuote: row[`q${i}`] }));
        return rowidAlias ? { cells, rowid: row.__rowid } : { cells };
    });
    return { columns, rows, hasMore: raw.length > 100, rowidAlias };
}
function literalText(value) {
    return value.split("\0").map(part => `'${part.replace(/'/g, "''")}'`).join(" || char(0) || ");
}
function cellValue(cell) {
    if (cell.type === "null")
        return "NULL";
    if (cell.type === "blob")
        return `X'${cell.hex}'`;
    const bytes = Buffer.from(cell.hex, "hex");
    if (cell.encoding === "UTF-16be")
        bytes.swap16();
    return bytes.toString(cell.encoding === "UTF-8" ? "utf8" : "utf16le");
}
function valueExpression(type, value) {
    if (type === "null")
        return "NULL";
    if (type === "text")
        return literalText(value);
    if (type === "blob") {
        if (!/^(?:[0-9a-fA-F]{2})*$/.test(value))
            throw new Error("BLOB values must contain an even number of hexadecimal digits.");
        return `X'${value}'`;
    }
    if (type === "integer") {
        if (!/^[+-]?\d+$/.test(value) || BigInt(value) < -9223372036854775808n || BigInt(value) > 9223372036854775807n) {
            throw new Error("Enter a signed 64-bit integer.");
        }
        return value;
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
        throw new Error("Enter a finite numeric value.");
    }
    return `CAST(${literalText(value)} AS REAL)`;
}
function rowWhere(page, rowIndex) {
    const row = page.rows[rowIndex];
    if (!row)
        throw new Error("This cell cannot be edited.");
    const conditions = page.columns.map((col, i) => {
        const cell = row.cells[i];
        if (!cell)
            throw new Error("The row snapshot is incomplete.");
        const realCheck = cell.type === "real" && cell.realQuote !== undefined ? ` AND quote(${identifier(col.name)}) = ${literalText(cell.realQuote)}` : "";
        return `typeof(${identifier(col.name)}) = '${cell.type}' AND hex(CAST(${identifier(col.name)} AS BLOB)) = '${cell.hex}'${realCheck}`;
    });
    if (page.rowidAlias && row.rowid !== undefined && /^-?\d+$/.test(row.rowid)) {
        conditions.push(`${identifier(page.rowidAlias)} = ${row.rowid}`);
    }
    return conditions.join(" AND ");
}
async function updateCells(executable, database, object, page, edits) {
    if (object.type !== "table" || !edits.length)
        throw new Error("This cell cannot be edited.");
    const table = identifier(object.name);
    const updates = new Map();
    for (const edit of edits) {
        if (!Number.isSafeInteger(edit.rowIndex) || !Number.isSafeInteger(edit.columnIndex) ||
            !page.rows[edit.rowIndex] || !page.columns[edit.columnIndex] ||
            page.columns[edit.columnIndex].hidden !== 0 || !isStorageType(edit.type)) {
            throw new Error("This cell cannot be edited.");
        }
        let rowUpdates = updates.get(edit.rowIndex);
        if (!rowUpdates) {
            rowUpdates = new Map();
            updates.set(edit.rowIndex, rowUpdates);
        }
        if (rowUpdates.has(edit.columnIndex))
            throw new Error("A cell can only be edited once per operation.");
        rowUpdates.set(edit.columnIndex, edit);
    }
    const statements = ["BEGIN IMMEDIATE;"];
    for (const [rowIndex, rowUpdates] of updates) {
        const where = rowWhere(page, rowIndex);
        const assignments = [...rowUpdates.values()].map(edit => {
            const column = page.columns[edit.columnIndex];
            return `${identifier(column.name)} = ${valueExpression(edit.type, edit.value)}`;
        });
        statements.push(`UPDATE ${table} SET ${assignments.join(", ")} WHERE ${where} AND (SELECT count(*) FROM ${table} WHERE ${where}) = 1;`, "SELECT CASE WHEN changes() = 1 THEN 1 ELSE abs(-9223372036854775807 - 1) END AS updated;");
    }
    statements.push("COMMIT;");
    try {
        await run(executable, database, statements.join("\n"));
    }
    catch (error) {
        if (error instanceof Error && error.message.includes("integer overflow")) {
            throw new Error("A row changed, disappeared, or is not uniquely identifiable. Refresh and try again.");
        }
        throw error;
    }
}
function isStorageType(type) {
    return type === "null" || type === "integer" || type === "real" || type === "text" || type === "blob";
}
async function updateCell(executable, database, object, page, rowIndex, columnIndex, type, value) {
    await updateCells(executable, database, object, page, [{ rowIndex, columnIndex, type, value }]);
}
async function executeSql(executable, database, sql) {
    if (!sql.trim())
        throw new Error("Enter SQL to execute.");
    if (/^\s*\.[a-z][a-z0-9_-]*(?:\s|$)/im.test(sql))
        throw new Error("SQLite CLI dot commands are not supported.");
    const output = await run(executable, database, sql, false, false);
    return output.trimEnd() || "Completed successfully (no rows returned).";
}
//# sourceMappingURL=database.js.map