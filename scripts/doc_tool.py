#!/usr/bin/env python3
"""Document bridge for dsh-linked-workspace.

Reads/edits Markdown, PDF, DOCX, XLSX and PPTX files.  It is intentionally a
small, dependency-light helper: python-docx / openpyxl / python-pptx / PyMuPDF
are only needed when the corresponding format is used.
"""
import argparse
import base64
import datetime
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

MAX_PDF_PAGES = 40
MAX_PDF_WIDTH = 1100
MAX_SHEET_ROWS = 200
MAX_SHEET_COLS = 40
MAX_PPTX_SLIDES = 80


def fail(message):
    print(json.dumps({"ok": False, "error": str(message)}, ensure_ascii=True))
    sys.exit(1)


def emit(data):
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=True))


def json_value(value):
    if value is None:
        return None
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, (int, float, bool, str)):
        return value
    return str(value)


# ── DOCX ──────────────────────────────────────────────────────────────────

def read_docx(path):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(path)
    paragraphs = []
    for paragraph in doc.paragraphs:
        paragraphs.append({
            "style": paragraph.style.name if paragraph.style is not None else "",
            "text": paragraph.text,
        })
    tables = []
    for table in doc.tables:
        rows = []
        for row in table.rows:
            rows.append([cell.text for cell in row.cells])
        tables.append(rows)
    emit({"kind": "docx", "paragraphs": paragraphs, "tables": tables})


def write_docx(source, data, out):
    from docx import Document

    doc = Document(source)
    paragraphs = data.get("paragraphs")
    if isinstance(paragraphs, list):
        for index, block in enumerate(paragraphs):
            if index >= len(doc.paragraphs):
                break
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                doc.paragraphs[index].text = block["text"]
    tables = data.get("tables")
    if isinstance(tables, list):
        for table_index, rows in enumerate(tables):
            if table_index >= len(doc.tables) or not isinstance(rows, list):
                continue
            table = doc.tables[table_index]
            for row_index, row in enumerate(rows):
                if row_index >= len(table.rows) or not isinstance(row, list):
                    continue
                for cell_index, value in enumerate(row):
                    if cell_index >= len(table.rows[row_index].cells):
                        continue
                    if isinstance(value, str):
                        table.rows[row_index].cells[cell_index].text = value
    doc.save(out)
    emit({"kind": "docx", "path": out})


# ── XLSX ──────────────────────────────────────────────────────────────────

def read_xlsx(path):
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=False)
    sheets = []
    for sheet in workbook.worksheets[:20]:
        rows = []
        max_row = min(sheet.max_row or 0, MAX_SHEET_ROWS)
        max_col = min(sheet.max_column or 0, MAX_SHEET_COLS)
        for row in sheet.iter_rows(min_row=1, max_row=max_row, min_col=1, max_col=max_col):
            rows.append([json_value(cell.value) for cell in row])
        sheets.append({
            "name": sheet.title,
            "rows": rows,
            "maxRow": max_row,
            "maxCol": max_col,
            "frozen": bool(sheet.freeze_panes),
        })
    emit({"kind": "xlsx", "sheets": sheets, "sheetCount": len(workbook.worksheets)})


def write_xlsx(source, data, out):
    from openpyxl import load_workbook

    workbook = load_workbook(source)
    updates = data.get("updates") or []
    for update in updates:
        if not isinstance(update, dict):
            continue
        sheet_name = update.get("sheet")
        cell = update.get("cell")
        value = update.get("value")
        if not isinstance(sheet_name, str) or not isinstance(cell, str):
            continue
        if sheet_name not in workbook.sheetnames:
            continue
        if not re.match(r"^[A-Za-z]{1,3}[1-9][0-9]*$", cell):
            continue
        if isinstance(value, str) and value.startswith("="):
            workbook[sheet_name][cell] = value
        elif isinstance(value, str) and re.match(r"^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$", value.strip()):
            number = value.strip()
            workbook[sheet_name][cell] = float(number) if "." in number else int(number)
        elif value == "":
            workbook[sheet_name][cell] = None
        else:
            workbook[sheet_name][cell] = value
    workbook.save(out)
    emit({"kind": "xlsx", "path": out})


# ── PPTX ──────────────────────────────────────────────────────────────────

def read_pptx(path):
    from pptx import Presentation

    presentation = Presentation(path)
    slides = []
    for slide_index, slide in enumerate(presentation.slides):
        if slide_index >= MAX_PPTX_SLIDES:
            break
        texts = []
        for shape_index, shape in enumerate(slide.shapes):
            if not getattr(shape, "has_text_frame", False):
                continue
            text = shape.text_frame.text
            if text.strip() == "":
                continue
            texts.append({
                "shape": shape_index,
                "name": getattr(shape, "name", ""),
                "text": text,
            })
        slides.append({"index": slide_index, "texts": texts})
    emit({"kind": "pptx", "slides": slides, "slideCount": len(presentation.slides)})


def write_pptx(source, data, out):
    from pptx import Presentation

    presentation = Presentation(source)
    updates = data.get("updates") or []
    for update in updates:
        if not isinstance(update, dict):
            continue
        slide_index = update.get("slide")
        shape_index = update.get("shape")
        text = update.get("text")
        if not isinstance(slide_index, int) or not isinstance(shape_index, int) or not isinstance(text, str):
            continue
        if slide_index < 0 or slide_index >= len(presentation.slides):
            continue
        slide = presentation.slides[slide_index]
        if shape_index < 0 or shape_index >= len(slide.shapes):
            continue
        shape = slide.shapes[shape_index]
        if not getattr(shape, "has_text_frame", False):
            continue
        shape.text_frame.text = text
    presentation.save(out)
    emit({"kind": "pptx", "path": out})


# ── PDF ───────────────────────────────────────────────────────────────────

def read_pdf(path, page_index=None):
    import fitz

    doc = fitz.open(path)
    pages = []
    indexes = [page_index] if isinstance(page_index, int) else [0]
    for index in indexes:
        if index < 0 or index >= doc.page_count:
            continue
        page = doc[index]
        rect = page.rect
        scale = min(1.5, MAX_PDF_WIDTH / max(rect.width, 1))
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        pages.append({
            "index": index,
            "width": rect.width,
            "height": rect.height,
            "rotation": page.rotation,
            "png": "data:image/png;base64," + base64.b64encode(pixmap.tobytes("png")).decode("ascii"),
        })
    metadata = doc.metadata or {}
    emit({
        "kind": "pdf",
        "pageCount": doc.page_count,
        "metadata": {
            "title": metadata.get("title", ""),
            "author": metadata.get("author", ""),
            "subject": metadata.get("subject", ""),
        },
        "pages": pages,
        "truncated": doc.page_count > 1,
    })


def write_pdf(source, data, out):
    import fitz

    doc = fitz.open(source)
    metadata = data.get("metadata") or {}
    if isinstance(metadata, dict):
        current = doc.metadata or {}
        current.update({
            "title": metadata.get("title", current.get("title", "")),
            "author": metadata.get("author", current.get("author", "")),
            "subject": metadata.get("subject", current.get("subject", "")),
        })
        doc.set_metadata(current)
    for item in data.get("rotations") or []:
        if not isinstance(item, dict):
            continue
        index = item.get("index")
        degrees = item.get("degrees")
        if isinstance(index, int) and 0 <= index < doc.page_count and isinstance(degrees, int):
            page = doc[index]
            page.set_rotation(degrees % 360)
    deleted = [item for item in (data.get("deleted") or []) if isinstance(item, int)]
    for index in sorted(set(deleted), reverse=True):
        if 0 <= index < doc.page_count and doc.page_count > 1:
            doc.delete_page(index)
    doc.save(out, garbage=3, deflate=True)
    doc.close()
    emit({"kind": "pdf", "path": out})


# ── create / Markdown ─────────────────────────────────────────────────────

def create(kind, out):
    if kind == "md":
        with open(out, "w", encoding="utf-8") as handle:
            handle.write("")
    elif kind == "docx":
        from docx import Document

        document = Document()
        document.add_paragraph("")
        document.save(out)
    elif kind == "xlsx":
        from openpyxl import Workbook

        workbook = Workbook()
        workbook.active.title = "Sheet1"
        workbook.save(out)
    elif kind == "pptx":
        from pptx import Presentation

        presentation = Presentation()
        layout = presentation.slide_layouts[1] if len(presentation.slide_layouts) > 1 else presentation.slide_layouts[0]
        slide = presentation.slides.add_slide(layout)
        slide.shapes.title.text = "New presentation"
        presentation.save(out)
    elif kind == "pdf":
        import fitz

        document = fitz.open()
        document.new_page()
        document.save(out)
        document.close()
    else:
        raise ValueError(f"unsupported kind: {kind}")
    emit({"kind": kind, "path": out})


def markdown_to_html(path):
    import markdown

    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    body = markdown.markdown(text, extensions=["extra", "sane_lists", "tables", "fenced_code"])
    html = """<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.65;color:#1f2328;max-width:900px;margin:0 auto;padding:28px;font-size:15px}
h1,h2,h3,h4{line-height:1.3;margin:1.2em 0 .55em} h1{font-size:1.8em;border-bottom:1px solid #e5e7eb;padding-bottom:.25em}
pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto} code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}
pre code{background:none;padding:0} blockquote{border-left:4px solid #d0d7de;margin:0;padding:0 1em;color:#57606a}
table{border-collapse:collapse;margin:1em 0} th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}
img{max-width:100%} a{color:#0969da} hr{border:0;border-top:1px solid #d0d7de;margin:1.5em 0}
</style></head><body>""" + body + "</body></html>"
    return html


def markdown_preview(path):
    html = markdown_to_html(path)
    emit({"kind": "markdown-preview", "html": html})


def markdown_pdf(path, out):
    import fitz

    html = markdown_to_html(path)
    story = fitz.Story(html=html)
    writer = fitz.DocumentWriter(out)
    mediabox = fitz.paper_rect("a4")
    page_rect = mediabox + (48, 48, -48, -48)
    more = True
    while more:
        device = writer.begin_page(mediabox)
        more, _ = story.place(page_rect)
        story.draw(device)
        writer.end_page()
    writer.close()
    emit({"kind": "pdf", "path": out})


# ── CLI ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="dsh-linked-workspace document bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    read = sub.add_parser("read")
    read.add_argument("--kind", required=True)
    read.add_argument("--file", required=True)
    read.add_argument("--page", type=int, default=None)

    write = sub.add_parser("write")
    write.add_argument("--kind", required=True)
    write.add_argument("--file", required=True)
    write.add_argument("--data", required=True)
    write.add_argument("--out", required=True)

    create_parser = sub.add_parser("create")
    create_parser.add_argument("--kind", required=True)
    create_parser.add_argument("--out", required=True)

    preview = sub.add_parser("md-preview")
    preview.add_argument("--file", required=True)

    pdf = sub.add_parser("md-pdf")
    pdf.add_argument("--file", required=True)
    pdf.add_argument("--out", required=True)

    args = parser.parse_args()
    try:
        if args.command == "read":
            if args.kind == "docx":
                read_docx(args.file)
            elif args.kind == "xlsx":
                read_xlsx(args.file)
            elif args.kind == "pptx":
                read_pptx(args.file)
            elif args.kind == "pdf":
                read_pdf(args.file, args.page)
            else:
                raise ValueError(f"unsupported kind: {args.kind}")
        elif args.command == "write":
            with open(args.data, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if args.kind == "docx":
                write_docx(args.file, data, args.out)
            elif args.kind == "xlsx":
                write_xlsx(args.file, data, args.out)
            elif args.kind == "pptx":
                write_pptx(args.file, data, args.out)
            elif args.kind == "pdf":
                write_pdf(args.file, data, args.out)
            else:
                raise ValueError(f"unsupported kind: {args.kind}")
        elif args.command == "create":
            create(args.kind, args.out)
        elif args.command == "md-preview":
            markdown_preview(args.file)
        elif args.command == "md-pdf":
            markdown_pdf(args.file, args.out)
    except Exception as error:  # pragma: no cover - CLI boundary
        fail(error)


if __name__ == "__main__":
    main()
