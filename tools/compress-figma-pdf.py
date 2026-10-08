"""Сжатие PDF, экспортированных из Figma (колоды GRAFF: тяжёлый титул со слоями рендера и масками прозрачности).

Основной вес таких файлов — не картинки, а их маски прозрачности (SMask, серые, без потерь) и слои по ~5700 px,
из которых на слайде видна малая часть. Обычные «оптимизаторы» (Ghostscript, PyMuPDF rewrite_images) маски не трогают.
Скрипт уменьшает слои и маски до заданного эффективного разрешения и кодирует их в JPEG. Текст, таблицы и вектор не меняются.

    python compress-figma-pdf.py вход.pdf выход.pdf [--dpi 110] [--quality 82] [--mask-quality 90]

Нужны: pip install pymupdf pillow
"""
import argparse, io, os, sys
import pymupdf
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def effective_dpi(doc):
    """xref картинки -> максимальное эффективное разрешение на страницах (по ширине размещения)."""
    dpi = {}
    for page in doc:
        for img in page.get_images(full=True):
            xref, width = img[0], img[2]
            for r in page.get_image_rects(xref):
                if r.width > 0:
                    dpi[xref] = max(dpi.get(xref, 0), width / (r.width / 72))
    return dpi


def reencode(doc, xref, scale, quality, gray):
    pix = pymupdf.Pixmap(doc, xref)
    if gray:
        if pix.n != 1:
            pix = pymupdf.Pixmap(pymupdf.csGRAY, pix)
        im = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    else:
        if pix.alpha or pix.n != 3:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    if scale < 1:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True, subsampling=0 if gray else 1)
    data = buf.getvalue()
    old = len(doc.xref_stream_raw(xref))
    if len(data) >= old:
        return old, old  # не стало меньше — оставляем как было
    doc.update_stream(xref, data, compress=False)
    doc.xref_set_key(xref, "Filter", "/DCTDecode")
    doc.xref_set_key(xref, "DecodeParms", "null")
    doc.xref_set_key(xref, "Width", str(im.width))
    doc.xref_set_key(xref, "Height", str(im.height))
    doc.xref_set_key(xref, "BitsPerComponent", "8")
    if gray:
        doc.xref_set_key(xref, "ColorSpace", "/DeviceGray")
    return old, len(data)


def compress(src, dst, dpi_target=110, quality=82, mask_quality=90, min_bytes=100_000):
    doc = pymupdf.open(src)
    dpi = effective_dpi(doc)
    done, before, after = set(), 0, 0
    for page in doc:
        for img in page.get_images(full=True):
            xref, smask = img[0], img[1]
            if xref in done:
                continue
            done.add(xref)
            scale = min(1.0, dpi_target / dpi[xref]) if dpi.get(xref) else 1.0
            cs = doc.xref_get_key(xref, "ColorSpace")[1]
            is_gray = "Gray" in cs
            # цветной слой: трогаем, только если уменьшаем (иначе повторное JPEG-сжатие без выгоды)
            if scale < 0.95 and len(doc.xref_stream_raw(xref)) >= min_bytes and "CMYK" not in cs:
                b, a = reencode(doc, xref, scale, quality, is_gray)
                before += b; after += a
            if smask and smask not in done:
                done.add(smask)
                if len(doc.xref_stream_raw(smask)) >= min_bytes and doc.xref_get_key(smask, "Matte")[0] == "null":
                    b, a = reencode(doc, smask, scale, mask_quality, True)
                    before += b; after += a
    doc.save(dst, garbage=4, deflate=True, deflate_images=False, clean=False)
    doc.close()
    return os.path.getsize(src), os.path.getsize(dst), before, after


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--dpi", type=int, default=110)
    ap.add_argument("--quality", type=int, default=82)
    ap.add_argument("--mask-quality", type=int, default=90)
    a = ap.parse_args()
    s, d, b, f = compress(a.src, a.dst, a.dpi, a.quality, a.mask_quality)
    print(f"{os.path.basename(a.src)}: {s/1e6:.1f} -> {d/1e6:.1f} МБ (слои и маски {b/1e6:.1f} -> {f/1e6:.1f} МБ)")
