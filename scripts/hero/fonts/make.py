"""Writes the static Overpass instances, cut to ASCII and a few marks, that the hero outlines its text from.

Run with fontTools and uharfbuzz installed:
    python make.py <Overpass[wght].ttf> <OverpassMono[wght].ttf>
The variable fonts come from https://github.com/google/fonts (ofl/overpass, ofl/overpassmono).
"""

import os
import sys

import uharfbuzz as hb
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._k_e_r_n import KernTable_format_0
from fontTools.varLib.instancer import instantiateVariableFont

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = "".join(chr(c) for c in range(0x20, 0x7F)) + "\u2019\u2026\u2013\u00b7\u00d7"
FACES = [
    ("sans", 0, (400, 600, 800)),
    ("mono", 1, (400, 600)),
]


def kerning(path, weight, glyphs, cmap):
    face = hb.Face(hb.Blob.from_file_path(path))
    font = hb.Font(face)
    font.set_variations({"wght": weight})

    def shape(text):
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(font, buf, {"kern": True, "liga": False, "clig": False, "calt": False, "dlig": False})
        return buf.glyph_positions

    single = {c: shape(c)[0].x_advance for c in TEXT}
    pairs = {}
    for a in TEXT:
        for b in TEXT:
            shaped = shape(a + b)
            if len(shaped) != 2:
                continue
            delta = shaped[0].x_advance + shaped[1].x_advance - single[a] - single[b]
            if delta != 0 and a in cmap and b in cmap:
                pairs[(cmap[a], cmap[b])] = delta
    return pairs


def main(sans, mono):
    sources = [sans, mono]
    for name, source, weights in FACES:
        path = sources[source]
        for weight in weights:
            font = instantiateVariableFont(TTFont(path), {"wght": weight})
            options = Options()
            options.layout_features = []
            options.hinting = False
            options.notdef_outline = False
            options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
            options.drop_tables += ["DSIG", "GPOS", "GSUB", "GDEF", "STAT", "HVAR", "gasp", "prep"]
            subsetter = Subsetter(options)
            subsetter.populate(text=TEXT)
            subsetter.subset(font)
            cmap = {chr(code): glyph for code, glyph in font.getBestCmap().items()}
            pairs = kerning(path, weight, font.getGlyphOrder(), cmap)
            if pairs:
                kern = newTable("kern")
                kern.version = 0
                table = KernTable_format_0()
                table.version = 0
                table.coverage = 1
                table.kernTable = pairs
                kern.kernTables = [table]
                font["kern"] = kern
            out = os.path.join(HERE, f"overpass-{name}-{weight}.ttf")
            font.save(out)
            print(f"{os.path.basename(out)}: {os.path.getsize(out)} bytes, {len(pairs)} kerning pairs")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
