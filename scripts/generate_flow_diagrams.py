#!/usr/bin/env python3
"""
Generate Shelob Web System Flow Diagrams as a PPTX presentation.
Uses dark theme matching the Shelob Web brand.
"""

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
import math

# ============================================================================
# THEME COLORS
# ============================================================================
BG_COLOR = RGBColor(0x0A, 0x0C, 0x14)
CARD_COLOR = RGBColor(0x13, 0x16, 0x24)
BORDER_COLOR = RGBColor(0x1E, 0x22, 0x35)
TEXT_COLOR = RGBColor(0xE2, 0xE8, 0xF0)
TEXT_MUTED = RGBColor(0x94, 0xA3, 0xB8)
INDIGO = RGBColor(0x63, 0x66, 0xF1)       # Primary flows
GREEN = RGBColor(0x34, 0xD3, 0x99)         # Success paths
RED = RGBColor(0xF8, 0x71, 0x71)           # Error paths
ORANGE = RGBColor(0xFB, 0xBF, 0x24)        # Gating/restrictions
PURPLE = RGBColor(0xC0, 0x84, 0xFC)        # AI features
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
DARK_CARD = RGBColor(0x0F, 0x11, 0x1A)

# Slide dimensions (16:9)
SLIDE_WIDTH = Inches(13.333)
SLIDE_HEIGHT = Inches(7.5)

prs = Presentation()
prs.slide_width = SLIDE_WIDTH
prs.slide_height = SLIDE_HEIGHT


def set_slide_bg(slide, color=BG_COLOR):
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = color


def add_shape(slide, left, top, width, height, fill_color=CARD_COLOR, border_color=BORDER_COLOR, shape_type=MSO_SHAPE.ROUNDED_RECTANGLE):
    shape = slide.shapes.add_shape(shape_type, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    shape.line.color.rgb = border_color
    shape.line.width = Pt(1.5)
    return shape


def add_text_to_shape(shape, text, font_size=11, color=TEXT_COLOR, bold=False, alignment=PP_ALIGN.CENTER):
    tf = shape.text_frame
    tf.word_wrap = True
    tf.auto_size = None
    p = tf.paragraphs[0]
    p.alignment = alignment
    run = p.add_run()
    run.text = text
    run.font.size = Pt(font_size)
    run.font.color.rgb = color
    run.font.bold = bold
    run.font.name = 'Calibri'
    return tf


def add_multiline_text(shape, lines, font_size=10, color=TEXT_COLOR, bold_first=False, alignment=PP_ALIGN.CENTER):
    tf = shape.text_frame
    tf.word_wrap = True
    tf.auto_size = None
    for i, line in enumerate(lines):
        if i == 0:
            p = tf.paragraphs[0]
        else:
            p = tf.add_paragraph()
        p.alignment = alignment
        run = p.add_run()
        run.text = line
        run.font.size = Pt(font_size)
        run.font.color.rgb = color
        run.font.bold = bold_first and i == 0
        run.font.name = 'Calibri'
    return tf


def add_connector(slide, x1, y1, x2, y2, color=INDIGO, width=Pt(2)):
    """Add a line connector between two points."""
    connector = slide.shapes.add_connector(
        1,  # MSO_CONNECTOR.STRAIGHT
        x1, y1, x2, y2
    )
    connector.line.color.rgb = color
    connector.line.width = width
    return connector


def add_arrow_connector(slide, x1, y1, x2, y2, color=INDIGO, width=Pt(2)):
    """Add a line with an arrowhead."""
    connector = slide.shapes.add_connector(
        1,  # straight
        x1, y1, x2, y2
    )
    connector.line.color.rgb = color
    connector.line.width = width
    # Add arrowhead
    from pptx.oxml.ns import qn
    ln = connector.line._ln
    tail = ln.makeelement(qn('a:tailEnd'), {'type': 'triangle', 'w': 'med', 'len': 'med'})
    ln.append(tail)
    return connector


def add_title(slide, text, subtitle=None):
    """Add a slide title."""
    title_shape = slide.shapes.add_textbox(Inches(0.5), Inches(0.25), Inches(12), Inches(0.7))
    tf = title_shape.text_frame
    p = tf.paragraphs[0]
    run = p.add_run()
    run.text = text
    run.font.size = Pt(28)
    run.font.color.rgb = WHITE
    run.font.bold = True
    run.font.name = 'Calibri'

    if subtitle:
        sub_shape = slide.shapes.add_textbox(Inches(0.5), Inches(0.85), Inches(12), Inches(0.4))
        tf2 = sub_shape.text_frame
        p2 = tf2.paragraphs[0]
        run2 = p2.add_run()
        run2.text = subtitle
        run2.font.size = Pt(14)
        run2.font.color.rgb = TEXT_MUTED
        run2.font.name = 'Calibri'


def add_label(slide, left, top, text, font_size=9, color=TEXT_MUTED, width=Inches(1.5)):
    """Add a small text label."""
    tb = slide.shapes.add_textbox(left, top, width, Inches(0.3))
    tf = tb.text_frame
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = text
    run.font.size = Pt(font_size)
    run.font.color.rgb = color
    run.font.name = 'Calibri'
    return tb


def process_box(slide, left, top, width, height, text, fill=CARD_COLOR, border=INDIGO, font_size=11, text_color=TEXT_COLOR):
    """Standard process rectangle."""
    s = add_shape(slide, left, top, width, height, fill, border, MSO_SHAPE.ROUNDED_RECTANGLE)
    add_text_to_shape(s, text, font_size, text_color, bold=True)
    return s


def decision_box(slide, left, top, width, height, text, fill=CARD_COLOR, border=ORANGE):
    """Diamond decision shape."""
    s = add_shape(slide, left, top, width, height, fill, border, MSO_SHAPE.DIAMOND)
    add_text_to_shape(s, text, 9, TEXT_COLOR, bold=True)
    return s


def data_store(slide, left, top, width, height, text, fill=CARD_COLOR, border=PURPLE):
    """Cylinder for data store."""
    s = add_shape(slide, left, top, width, height, fill, border, MSO_SHAPE.CAN)
    add_text_to_shape(s, text, 10, TEXT_COLOR, bold=True)
    return s


def start_end(slide, left, top, width, height, text, fill=INDIGO, border=INDIGO):
    """Rounded rectangle for start/end terminals."""
    s = add_shape(slide, left, top, width, height, fill, border, MSO_SHAPE.ROUNDED_RECTANGLE)
    add_text_to_shape(s, text, 11, WHITE, bold=True)
    return s


def error_box(slide, left, top, width, height, text, fill=CARD_COLOR, border=RED):
    """Error/failure box."""
    s = add_shape(slide, left, top, width, height, fill, border, MSO_SHAPE.ROUNDED_RECTANGLE)
    add_text_to_shape(s, text, 10, RED, bold=True)
    return s


def success_box(slide, left, top, width, height, text, fill=CARD_COLOR, border=GREEN):
    """Success box."""
    s = add_shape(slide, left, top, width, height, fill, border, MSO_SHAPE.ROUNDED_RECTANGLE)
    add_text_to_shape(s, text, 10, GREEN, bold=True)
    return s


def gated_box(slide, left, top, width, height, text, fill=CARD_COLOR, border=ORANGE):
    """Gated/restricted box."""
    s = add_shape(slide, left, top, width, height, fill, border, MSO_SHAPE.ROUNDED_RECTANGLE)
    add_text_to_shape(s, text, 10, ORANGE, bold=True)
    return s


def ai_box(slide, left, top, width, height, text, fill=CARD_COLOR, border=PURPLE):
    """AI feature box."""
    s = add_shape(slide, left, top, width, height, fill, border, MSO_SHAPE.ROUNDED_RECTANGLE)
    add_text_to_shape(s, text, 10, PURPLE, bold=True)
    return s


def cx(shape):
    """Center X of a shape."""
    return shape.left + shape.width // 2

def cy(shape):
    """Center Y of a shape."""
    return shape.top + shape.height // 2

def bottom(shape):
    return shape.top + shape.height

def right_edge(shape):
    return shape.left + shape.width

def top_edge(shape):
    return shape.top

def left_edge(shape):
    return shape.left


# ============================================================================
# SLIDE 1: Title Slide
# ============================================================================
slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
set_slide_bg(slide)

# Title
title_box = slide.shapes.add_textbox(Inches(1), Inches(2.2), Inches(11), Inches(1.2))
tf = title_box.text_frame
p = tf.paragraphs[0]
p.alignment = PP_ALIGN.CENTER
run = p.add_run()
run.text = "Shelob Web"
run.font.size = Pt(54)
run.font.color.rgb = WHITE
run.font.bold = True
run.font.name = 'Calibri'

p2 = tf.add_paragraph()
p2.alignment = PP_ALIGN.CENTER
run2 = p2.add_run()
run2.text = "System Flow Diagrams"
run2.font.size = Pt(36)
run2.font.color.rgb = INDIGO
run2.font.bold = False
run2.font.name = 'Calibri'

# Subtitle
sub_box = slide.shapes.add_textbox(Inches(2), Inches(3.8), Inches(9), Inches(0.8))
tf2 = sub_box.text_frame
p3 = tf2.paragraphs[0]
p3.alignment = PP_ALIGN.CENTER
run3 = p3.add_run()
run3.text = "Architecture & Data Flow Reference  |  Cloudflare Workers + D1 + KV"
run3.font.size = Pt(16)
run3.font.color.rgb = TEXT_MUTED
run3.font.name = 'Calibri'

# Legend
legend_y = Inches(5.0)
legend_items = [
    ("Primary Flow", INDIGO),
    ("Success", GREEN),
    ("Error", RED),
    ("Gating", ORANGE),
    ("AI Feature", PURPLE),
]
legend_start_x = Inches(2.5)
spacing = Inches(1.8)

for i, (label, color) in enumerate(legend_items):
    x = legend_start_x + spacing * i
    dot = slide.shapes.add_shape(MSO_SHAPE.OVAL, x, legend_y, Inches(0.18), Inches(0.18))
    dot.fill.solid()
    dot.fill.fore_color.rgb = color
    dot.line.fill.background()
    add_label(slide, x + Inches(0.25), legend_y - Inches(0.02), label, 11, TEXT_COLOR, Inches(1.2))


# ============================================================================
# SLIDE 2: User Onboarding Flow
# ============================================================================
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide)
add_title(slide, "1. User Onboarding Flow", "Sign up > Magic link > Login > Add website > Quick audit > Full audit > Dashboard")

# Row 1: Auth flow
bw = Inches(1.6)
bh = Inches(0.65)
gap = Inches(0.35)
y1 = Inches(1.7)
x_start = Inches(0.4)

s1 = start_end(slide, x_start, y1, bw, bh, "Marketing Page")
x = x_start + bw + gap
s2 = process_box(slide, x, y1, bw, bh, "Enter Email\n/login", border=INDIGO)
x += bw + gap
s3 = process_box(slide, x, y1, bw, bh, "POST\n/api/auth/login", border=INDIGO)
x += bw + gap
s4 = process_box(slide, x, y1, bw, bh, "Brevo API\nSend Magic Link", border=INDIGO)
x += bw + gap
s5 = process_box(slide, x, y1, bw, bh, "Store Token\nin D1", border=INDIGO)
x += bw + gap
s6 = process_box(slide, x, y1, bw, bh, "User Clicks\nEmail Link", border=GREEN)

# Arrows row 1
for a, b in [(s1, s2), (s2, s3), (s3, s4), (s4, s5), (s5, s6)]:
    add_arrow_connector(slide, right_edge(a), cy(a), left_edge(b), cy(b), INDIGO)

# Row 2: Verify + session
y2 = Inches(2.8)
x = x_start
s7 = process_box(slide, x, y2, bw, bh, "GET /api/auth\n/verify?token=X", border=INDIGO)
x += bw + gap
s8 = decision_box(slide, x, y2, Inches(1.3), Inches(1.0), "Token\nValid?", border=ORANGE)
x += Inches(1.3) + gap

# Error branch
s8e = error_box(slide, x, y2 + Inches(1.3), bw, Inches(0.55), "Expired / Invalid")
add_arrow_connector(slide, cx(s8), bottom(s8), cx(s8e), top_edge(s8e), RED)
add_label(slide, cx(s8) - Inches(0.3), bottom(s8) + Inches(0.05), "No", 9, RED, Inches(0.6))

s9 = process_box(slide, x, y2, bw, bh, "Upsert User\nin D1", border=GREEN)
x += bw + gap
s10 = process_box(slide, x, y2, bw, bh, "Create Session\nin KV (30d TTL)", border=GREEN)
x += bw + gap
s11 = process_box(slide, x, y2, bw, bh, "Set Cookie\nRedirect /dashboard", border=GREEN)

# Arrow from email link down to verify
add_arrow_connector(slide, cx(s6), bottom(s6), cx(s7), top_edge(s7), GREEN)
# Use a connector going left from s6 bottom
add_arrow_connector(slide, right_edge(s7), cy(s7), left_edge(s8), cy(s8), INDIGO)
add_arrow_connector(slide, right_edge(s8), cy(s8), left_edge(s9), cy(s9), GREEN)
add_label(slide, right_edge(s8) + Inches(0.02), cy(s8) - Inches(0.25), "Yes", 9, GREEN, Inches(0.5))
add_arrow_connector(slide, right_edge(s9), cy(s9), left_edge(s10), cy(s10), GREEN)
add_arrow_connector(slide, right_edge(s10), cy(s10), left_edge(s11), cy(s11), GREEN)

# Row 3: Add website + audit
y3 = Inches(4.3)
x = x_start
s12 = process_box(slide, x, y3, bw, bh, "Dashboard\nLoads", border=INDIGO)
x += bw + gap
s13 = decision_box(slide, x, y3, Inches(1.3), Inches(1.0), "Plan\nLimits?", border=ORANGE)
x += Inches(1.3) + gap
s14 = process_box(slide, x, y3, bw, bh, "POST\n/api/properties\nAdd Website", border=INDIGO)
x += bw + gap
s15 = process_box(slide, x, y3, bw, bh, "Quick Audit\nHomepage Only\n(3-5 sec)", border=GREEN)
x += bw + gap
s16 = ai_box(slide, x, y3, bw, bh, "Full Sitemap\nAudit (BG)")
x += bw + gap
s17 = success_box(slide, x, y3, bw, bh, "Dashboard\nWith Results")

add_arrow_connector(slide, cx(s11), bottom(s11), cx(s12), top_edge(s12), GREEN)
add_arrow_connector(slide, right_edge(s12), cy(s12), left_edge(s13), cy(s13), INDIGO)

s13e = gated_box(slide, left_edge(s13) - Inches(0.1), y3 + Inches(1.3), Inches(1.5), Inches(0.55), "Upgrade Required")
add_arrow_connector(slide, cx(s13), bottom(s13), cx(s13e), top_edge(s13e), ORANGE)
add_label(slide, cx(s13) - Inches(0.3), bottom(s13) + Inches(0.05), "Over", 9, ORANGE, Inches(0.6))

add_arrow_connector(slide, right_edge(s13), cy(s13), left_edge(s14), cy(s14), GREEN)
add_label(slide, right_edge(s13) + Inches(0.02), cy(s13) - Inches(0.25), "OK", 9, GREEN, Inches(0.5))
add_arrow_connector(slide, right_edge(s14), cy(s14), left_edge(s15), cy(s15), INDIGO)
add_arrow_connector(slide, right_edge(s15), cy(s15), left_edge(s16), cy(s16), PURPLE)
add_arrow_connector(slide, right_edge(s16), cy(s16), left_edge(s17), cy(s17), GREEN)

# Row 3 details
y4 = Inches(5.6)
detail_w = Inches(2.8)
detail_h = Inches(1.2)
d1 = add_shape(slide, Inches(0.4), y4, detail_w, detail_h, DARK_CARD, BORDER_COLOR)
add_multiline_text(d1, ["Quick Audit Checks:", "Title, Meta Desc, H1, Schema", "Accessibility, Broken Links", "PageSpeed Insights (CrUX/Lab)"], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)

d2 = add_shape(slide, Inches(3.5), y4, detail_w, detail_h, DARK_CARD, BORDER_COLOR)
add_multiline_text(d2, ["Full Audit Pipeline:", "Sitemap crawl (500 pages max)", "SEO + A11y + Broken Links", "AI Readiness + Schema Validation"], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)

d3 = add_shape(slide, Inches(6.6), y4, detail_w, detail_h, DARK_CARD, BORDER_COLOR)
add_multiline_text(d3, ["Data Storage:", "D1: audits, issues, broken_links", "D1: accessibility_issues, keywords", "KV: session cache, quick audit cache"], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)

d4 = add_shape(slide, Inches(9.7), y4, detail_w, detail_h, DARK_CARD, BORDER_COLOR)
add_multiline_text(d4, ["Auth Details:", "Magic link via Brevo (15 min TTL)", "Sessions in KV (30 day TTL)", "7-day trial on first signup"], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)


# ============================================================================
# SLIDE 3: Google OAuth Flow
# ============================================================================
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide)
add_title(slide, "2. Google OAuth Flow", "Connect Google > Token reuse check > OAuth redirect OR token copy > Auto-discover GA4 + Search Console")

bw2 = Inches(1.7)
bh2 = Inches(0.7)
gap2 = Inches(0.3)

# Row 1: Start
y1 = Inches(1.7)
x = Inches(0.3)
g1 = start_end(slide, x, y1, bw2, bh2, "Click 'Connect\nGoogle'")
x += bw2 + gap2
g2 = process_box(slide, x, y1, bw2, bh2, "GET /api/oauth\n/google/start", border=INDIGO)
x += bw2 + gap2
g3 = decision_box(slide, x, y1, Inches(1.5), Inches(1.1), "Existing\nToken on\nOther Prop?", border=ORANGE)

# Yes branch (token reuse) - goes down
yr = Inches(3.2)
g4 = process_box(slide, left_edge(g3) - Inches(0.1), yr, bw2, bh2, "Copy Encrypted\nRefresh Token", border=GREEN)
add_arrow_connector(slide, cx(g3), bottom(g3), cx(g4), top_edge(g4), GREEN)
add_label(slide, cx(g3) + Inches(0.15), bottom(g3) + Inches(0.05), "Yes", 9, GREEN, Inches(0.5))

# No branch (full OAuth) - goes right
x_no = left_edge(g3) + Inches(1.5) + gap2
g5 = process_box(slide, x_no, y1, bw2, bh2, "Create OAuth\nState in D1", border=INDIGO)
add_arrow_connector(slide, right_edge(g3), cy(g3), left_edge(g5), cy(g5), INDIGO)
add_label(slide, right_edge(g3) + Inches(0.02), cy(g3) - Inches(0.25), "No", 9, INDIGO, Inches(0.5))

x_no += bw2 + gap2
g6 = process_box(slide, x_no, y1, bw2, bh2, "302 Redirect to\nGoogle Consent", border=INDIGO)
x_no += bw2 + gap2
g7 = process_box(slide, x_no, y1, bw2, bh2, "User Grants\nGA4 + GSC\nRead Access", border=GREEN)

# Arrow connections
add_arrow_connector(slide, right_edge(g1), cy(g1), left_edge(g2), cy(g2), INDIGO)
add_arrow_connector(slide, right_edge(g2), cy(g2), left_edge(g3), cy(g3), INDIGO)
add_arrow_connector(slide, right_edge(g5), cy(g5), left_edge(g6), cy(g6), INDIGO)
add_arrow_connector(slide, right_edge(g6), cy(g6), left_edge(g7), cy(g7), GREEN)

# Row 2: Callback
y2 = Inches(3.2)
x_no2 = left_edge(g5)
g8 = process_box(slide, x_no2, y2, bw2, bh2, "GET /api/oauth\n/google/callback", border=INDIGO)
add_arrow_connector(slide, cx(g7), bottom(g7), cx(g8), top_edge(g8), GREEN)

x_no2 += bw2 + gap2
g9 = process_box(slide, x_no2, y2, bw2, bh2, "Exchange Code\nfor Tokens", border=INDIGO)
x_no2 += bw2 + gap2
g10 = process_box(slide, x_no2, y2, bw2, bh2, "Encrypt Token\n(AES-GCM)\nStore in D1", border=GREEN)

add_arrow_connector(slide, right_edge(g8), cy(g8), left_edge(g9), cy(g9), INDIGO)
add_arrow_connector(slide, right_edge(g9), cy(g9), left_edge(g10), cy(g10), GREEN)

# Row 3: Auto-discover (shared by both paths)
y3 = Inches(4.5)
x = Inches(0.5)
g11 = process_box(slide, x, y3, Inches(2.0), bh2, "Auto-Discover\nGA4 Properties", border=PURPLE)
x += Inches(2.0) + gap2
g12 = decision_box(slide, x, y3, Inches(1.5), Inches(1.0), "Domain\nMatch?", border=ORANGE)
x += Inches(1.5) + gap2
g13 = process_box(slide, x, y3, bw2, bh2, "Set\nga4_property_id\nin D1", border=GREEN)
x += bw2 + gap2
g14 = process_box(slide, x, y3, Inches(2.0), bh2, "Auto-Discover\nSearch Console\nSites", border=PURPLE)
x += Inches(2.0) + gap2
g15 = process_box(slide, x, y3, bw2, bh2, "Set\ngsc_properties\nin D1", border=GREEN)
x += bw2 + gap2
g16 = success_box(slide, x, y3, bw2, bh2, "Google\nConnected!")

# Arrows from both paths to auto-discover
add_arrow_connector(slide, cx(g4), bottom(g4), cx(g11), top_edge(g11), GREEN)
add_arrow_connector(slide, cx(g10), bottom(g10), Inches(6), top_edge(g14), GREEN)

add_arrow_connector(slide, right_edge(g11), cy(g11), left_edge(g12), cy(g12), PURPLE)
add_arrow_connector(slide, right_edge(g12), cy(g12), left_edge(g13), cy(g13), GREEN)
add_label(slide, right_edge(g12) + Inches(0.02), cy(g12) - Inches(0.25), "Yes", 9, GREEN, Inches(0.5))
add_arrow_connector(slide, right_edge(g13), cy(g13), left_edge(g14), cy(g14), PURPLE)
add_arrow_connector(slide, right_edge(g14), cy(g14), left_edge(g15), cy(g15), GREEN)
add_arrow_connector(slide, right_edge(g15), cy(g15), left_edge(g16), cy(g16), GREEN)

# No match from decision
g12_no = add_label(slide, cx(g12) - Inches(0.3), bottom(g12) + Inches(0.05), "No: Picker", 9, ORANGE, Inches(0.8))

# Row 4: Background prefetch
y4 = Inches(5.8)
x = Inches(0.5)
g17 = ai_box(slide, x, y4, Inches(2.5), Inches(0.6), "Background Prefetch")
x += Inches(2.5) + gap2
g18 = process_box(slide, x, y4, Inches(2.2), Inches(0.6), "fetchGA4Analytics()\nImmediate data fetch", border=PURPLE)
x += Inches(2.2) + gap2
g19 = process_box(slide, x, y4, Inches(2.5), Inches(0.6), "fetchAndStoreSearchConsole()\nKeywords to D1", border=PURPLE)
x += Inches(2.5) + gap2
g20 = success_box(slide, x, y4, Inches(2.3), Inches(0.6), "Data ready on\nnext dashboard load")

add_arrow_connector(slide, cx(g16), bottom(g16), cx(g17), top_edge(g17), GREEN)
add_arrow_connector(slide, right_edge(g17), cy(g17), left_edge(g18), cy(g18), PURPLE)
add_arrow_connector(slide, right_edge(g18), cy(g18), left_edge(g19), cy(g19), PURPLE)
add_arrow_connector(slide, right_edge(g19), cy(g19), left_edge(g20), cy(g20), GREEN)

# Gating note
gn = add_shape(slide, Inches(0.3), Inches(6.7), Inches(4), Inches(0.5), DARK_CARD, ORANGE)
add_text_to_shape(gn, "GATED: Google integration requires a paid plan (Pro/Agency)", 10, ORANGE, True)


# ============================================================================
# SLIDE 4: Nightly Data Pipeline Flow
# ============================================================================
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide)
add_title(slide, "3. Nightly Data Pipeline", "Scheduled audit > Sitemap crawl > SEO checks > A11y > Broken links > AI Readiness > Store to D1")

bw3 = Inches(1.6)
bh3 = Inches(0.65)

# Row 1: Trigger
y1 = Inches(1.6)
x = Inches(0.3)
n1 = start_end(slide, x, y1, bw3, bh3, "Cron Trigger\n(wrangler.toml)")
x += bw3 + Inches(0.25)
n2 = process_box(slide, x, y1, bw3, bh3, "runScheduled\nAudit()", border=INDIGO)
x += bw3 + Inches(0.25)
n3 = process_box(slide, x, y1, Inches(2.0), bh3, "Query D1:\nAll active properties\n(filter expired trials)", border=INDIGO)
x += Inches(2.0) + Inches(0.25)
n4 = process_box(slide, x, y1, bw3, bh3, "Batch 5\nproperties\nat a time", border=INDIGO)
x += bw3 + Inches(0.25)
n5 = process_box(slide, x, y1, bw3, bh3, "runFullSitemap\nAudit(domain)", border=INDIGO)

add_arrow_connector(slide, right_edge(n1), cy(n1), left_edge(n2), cy(n2), INDIGO)
add_arrow_connector(slide, right_edge(n2), cy(n2), left_edge(n3), cy(n3), INDIGO)
add_arrow_connector(slide, right_edge(n3), cy(n3), left_edge(n4), cy(n4), INDIGO)
add_arrow_connector(slide, right_edge(n4), cy(n4), left_edge(n5), cy(n5), INDIGO)

# Row 2: Crawl pipeline
y2 = Inches(2.7)
x = Inches(0.3)
n6 = process_box(slide, x, y2, bw3, bh3, "Fetch\nrobots.txt\n(find sitemap)", border=INDIGO)
x += bw3 + Inches(0.25)
n7 = process_box(slide, x, y2, bw3, bh3, "Parse Sitemap\nXML (recursive\nindex support)", border=INDIGO)
x += bw3 + Inches(0.25)
n8 = process_box(slide, x, y2, bw3, bh3, "Deduplicate\nURLs\n(max 500)", border=INDIGO)
x += bw3 + Inches(0.25)
n9 = process_box(slide, x, y2, Inches(2.0), bh3, "Batch Audit Pages\n(10 at a time)\nTitle, Desc, H1, Schema", border=INDIGO)
x += Inches(2.0) + Inches(0.25)
n10 = process_box(slide, x, y2, bw3, bh3, "Collect All\nInternal Links", border=INDIGO)

add_arrow_connector(slide, cx(n5), bottom(n5), cx(n6), top_edge(n6), INDIGO)
add_arrow_connector(slide, right_edge(n6), cy(n6), left_edge(n7), cy(n7), INDIGO)
add_arrow_connector(slide, right_edge(n7), cy(n7), left_edge(n8), cy(n8), INDIGO)
add_arrow_connector(slide, right_edge(n8), cy(n8), left_edge(n9), cy(n9), INDIGO)
add_arrow_connector(slide, right_edge(n9), cy(n9), left_edge(n10), cy(n10), INDIGO)

# Row 3: Analysis + storage
y3 = Inches(3.8)
x = Inches(0.3)
n11 = process_box(slide, x, y3, bw3, bh3, "Check Broken\nLinks (HTTP\nstatus, max 100)", border=RED)
x += bw3 + Inches(0.25)
n12 = ai_box(slide, x, y3, bw3, bh3, "AI Readiness\nCheck (robots\nschema, etc.)")
x += bw3 + Inches(0.25)
n13 = process_box(slide, x, y3, bw3, bh3, "Generate SEO\nIssue List\n(severity-ranked)", border=INDIGO)
x += bw3 + Inches(0.25)
n14 = data_store(slide, x, y3, bw3, bh3, "Store in D1\naudits, issues\nbroken_links")
x += bw3 + Inches(0.25)
n15 = ai_box(slide, x, y3, bw3, bh3, "Generate AI\nSuggestions\n(Workers AI)")

add_arrow_connector(slide, cx(n10), bottom(n10), cx(n11), top_edge(n11), RED)
add_arrow_connector(slide, right_edge(n11), cy(n11), left_edge(n12), cy(n12), PURPLE)
add_arrow_connector(slide, right_edge(n12), cy(n12), left_edge(n13), cy(n13), INDIGO)
add_arrow_connector(slide, right_edge(n13), cy(n13), left_edge(n14), cy(n14), INDIGO)
add_arrow_connector(slide, right_edge(n14), cy(n14), left_edge(n15), cy(n15), PURPLE)

# Row 4: External data collection
y4 = Inches(4.9)
x = Inches(0.3)
n16 = process_box(slide, x, y4, Inches(2.0), bh3, "PageSpeed Insights\n(CrUX or Lighthouse)", border=GREEN)
x += Inches(2.0) + Inches(0.25)
n17 = data_store(slide, x, y4, Inches(2.0), bh3, "performance_history\n(LCP, FCP, CLS, INP, TTFB)")
x += Inches(2.0) + Inches(0.25)
n18 = data_store(slide, x, y4, Inches(2.0), bh3, "performance_snapshots\n(CWV + CF + GA4 + A11y)")
x += Inches(2.0) + Inches(0.25)
n19 = process_box(slide, x, y4, Inches(2.0), bh3, "Search Console:\nfetchAndStore\nSearchConsole()", border=GREEN)
x += Inches(2.0) + Inches(0.25)
n20 = data_store(slide, x, y4, bw3, bh3, "keywords\ntable\n(top 50)")

add_arrow_connector(slide, cx(n14), bottom(n14), cx(n16), top_edge(n16), INDIGO)
add_arrow_connector(slide, right_edge(n16), cy(n16), left_edge(n17), cy(n17), GREEN)
add_arrow_connector(slide, right_edge(n17), cy(n17), left_edge(n18), cy(n18), GREEN)
add_arrow_connector(slide, right_edge(n18), cy(n18), left_edge(n19), cy(n19), GREEN)
add_arrow_connector(slide, right_edge(n19), cy(n19), left_edge(n20), cy(n20), GREEN)

# Detail boxes at bottom
y5 = Inches(6.0)
d1 = add_shape(slide, Inches(0.3), y5, Inches(3.2), Inches(1.1), DARK_CARD, BORDER_COLOR)
add_multiline_text(d1, ["SEO Checks per Page:", "Title (30-60 chars), Meta desc (120-160)", "H1 (exactly 1), Schema.org JSON-LD", "Image alt text, Internal link graph"], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)

d2 = add_shape(slide, Inches(3.7), y5, Inches(3.2), Inches(1.1), DARK_CARD, BORDER_COLOR)
add_multiline_text(d2, ["AI Readiness Checks:", "robots.txt AI bot directives", "Schema.org structured data coverage", "Content accessibility for LLMs", "Domain-level readiness score"], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)

d3 = add_shape(slide, Inches(7.1), y5, Inches(3.0), Inches(1.1), DARK_CARD, BORDER_COLOR)
add_multiline_text(d3, ["PageSpeed Insights:", "Try bare domain, then www", "CrUX (origin/URL) preferred", "Lighthouse lab data fallback", "Accessibility score extracted"], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)

d4 = add_shape(slide, Inches(10.3), y5, Inches(2.8), Inches(1.1), DARK_CARD, BORDER_COLOR)
add_multiline_text(d4, ["Issue Lifecycle:", "first_seen -> open", "auto-fixed (next crawl)", "manually_fixed (user mark)", "reactivated (regressed)"], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)


# ============================================================================
# SLIDE 5: Dashboard Data Loading Flow
# ============================================================================
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide)
add_title(slide, "4. Dashboard Data Loading Flow", "Login > /api/me > /api/properties > Portfolio overview > Property detail > Tab loading")

bw4 = Inches(1.55)
bh4 = Inches(0.6)

# Row 1: Initial load
y1 = Inches(1.6)
x = Inches(0.3)
d1 = start_end(slide, x, y1, bw4, bh4, "Dashboard\nPage Load")
x += bw4 + Inches(0.25)
d2 = process_box(slide, x, y1, bw4, bh4, "GET /api/me\nResolve user\nplan, billing", border=INDIGO)
x += bw4 + Inches(0.25)
d3 = decision_box(slide, x, y1, Inches(1.3), Inches(0.95), "Trial\nExpired?", border=ORANGE)
x_after_d = x + Inches(1.3) + Inches(0.25)
d4 = gated_box(slide, x, y1 + Inches(1.2), Inches(1.3), Inches(0.5), "Lockout:\nUpgrade UI")
add_arrow_connector(slide, cx(d3), bottom(d3), cx(d4), top_edge(d4), ORANGE)
add_label(slide, cx(d3) + Inches(0.15), bottom(d3) + Inches(0.02), "Yes", 9, ORANGE, Inches(0.5))

d5 = process_box(slide, x_after_d, y1, Inches(1.8), bh4, "resolveEffectiveUser\n(team member?\nuse owner's data)", border=INDIGO)
add_arrow_connector(slide, right_edge(d3), cy(d3), left_edge(d5), cy(d5), GREEN)
add_label(slide, right_edge(d3) + Inches(0.02), cy(d3) - Inches(0.22), "No", 9, GREEN, Inches(0.5))

x = left_edge(d5) + Inches(1.8) + Inches(0.25)
d6 = process_box(slide, x, y1, bw4, bh4, "GET\n/api/properties\nList all sites", border=INDIGO)
x += bw4 + Inches(0.25)
d7 = process_box(slide, x, y1, bw4, bh4, "GET /api/data\nPortfolio\nOverview", border=INDIGO)

add_arrow_connector(slide, right_edge(d1), cy(d1), left_edge(d2), cy(d2), INDIGO)
add_arrow_connector(slide, right_edge(d2), cy(d2), left_edge(d3), cy(d3), INDIGO)
add_arrow_connector(slide, right_edge(d5), cy(d5), left_edge(d6), cy(d6), INDIGO)
add_arrow_connector(slide, right_edge(d6), cy(d6), left_edge(d7), cy(d7), INDIGO)

# Row 2: Property detail tabs
y2 = Inches(3.0)
x = Inches(0.3)
d8 = process_box(slide, x, y2, Inches(1.8), bh4, "Click Property\nGET /api/data\n?property=ID", border=INDIGO)

# Tab boxes
tab_y = Inches(3.9)
tab_w = Inches(1.85)
tab_h = Inches(1.3)
tab_gap = Inches(0.18)
tabs = [
    ("SEO Tab", ["/api/seo-stats", "/api/site-health", "Issues, broken links", "Fixed this week"], INDIGO),
    ("Performance Tab", ["/api/performance", "Cloudflare traffic", "GA4 analytics", "Core Web Vitals"], GREEN),
    ("Search Console", ["/api/search-console", "Top queries + pages", "Indexing status", "Position changes"], GREEN),
    ("GA4 Analytics", ["/api/performance", "Sessions, users", "Bounce rate", "Top pages"], GREEN),
    ("Accessibility", ["/api/accessibility", "Lighthouse a11y score", "Failing audits", "Element selectors"], INDIGO),
    ("AI Readiness", ["/api/ai-readiness", "Bot directives", "Schema coverage", "Readiness score"], PURPLE),
    ("Keywords", ["/api/keywords", "Top 50 queries", "Position tracking", "Week-over-week"], GREEN),
]

add_arrow_connector(slide, cx(d7), bottom(d7), cx(d8), top_edge(d8), INDIGO)

for i, (title, lines, color) in enumerate(tabs):
    tx = Inches(0.3) + i * (tab_w + tab_gap)
    t = add_shape(slide, tx, tab_y, tab_w, tab_h, CARD_COLOR, color)
    all_lines = [title] + lines
    add_multiline_text(t, all_lines, 9, TEXT_COLOR, True, PP_ALIGN.LEFT)
    add_arrow_connector(slide, cx(d8), bottom(d8), tx + tab_w // 2, tab_y, color)

# Row 4: Credential resolution
y5 = Inches(5.6)
cr1 = add_shape(slide, Inches(0.3), y5, Inches(4.2), Inches(1.1), DARK_CARD, BORDER_COLOR)
add_multiline_text(cr1, [
    "Credential Resolution (handlers.js):",
    "1. Check D1 property for OAuth refresh token",
    "2. Fall back to env GOOGLE_SERVICE_ACCOUNT",
    "3. Cloudflare: property CF token or env token",
    "4. Resolve effective user for team access"
], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)

cr2 = add_shape(slide, Inches(4.7), y5, Inches(4.0), Inches(1.1), DARK_CARD, BORDER_COLOR)
add_multiline_text(cr2, [
    "Caching Strategy:",
    "D1 performance_snapshots (24hr cache)",
    "Stale-while-revalidate pattern",
    "Fresh fetch if GA4 newly configured",
    "KV cache for quick audit results"
], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)

cr3 = add_shape(slide, Inches(8.9), y5, Inches(4.2), Inches(1.1), DARK_CARD, BORDER_COLOR)
add_multiline_text(cr3, [
    "Feature Gating by Plan:",
    "Trial: SEO, Performance, basic A11y",
    "Pro ($29/mo): + Google, Cloudflare, SC",
    "Agency ($59/mo): + Team, AI suggestions",
    "AI Readiness: Paid plans only"
], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)


# ============================================================================
# SLIDE 6: Billing & Plan Gating Flow
# ============================================================================
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide)
add_title(slide, "5. Billing & Plan Gating Flow", "Trial > Expired lockout > Checkout > Stripe webhook > Plan upgrade > Feature unlock")

bw5 = Inches(1.7)
bh5 = Inches(0.65)

# Row 1: Trial lifecycle
y1 = Inches(1.7)
x = Inches(0.3)
b1 = start_end(slide, x, y1, bw5, bh5, "New User\nSignup")
x += bw5 + Inches(0.3)
b2 = process_box(slide, x, y1, bw5, bh5, "Plan = 'trial'\ntrial_ends_at\n= +7 days", border=INDIGO)
x += bw5 + Inches(0.3)
b3 = process_box(slide, x, y1, bw5, bh5, "1 Site Allowed\nBasic Features\nOnly", border=INDIGO)
x += bw5 + Inches(0.3)
b4 = decision_box(slide, x, y1, Inches(1.4), Inches(1.0), "Trial\nExpired?", border=ORANGE)
x += Inches(1.4) + Inches(0.3)
b5 = gated_box(slide, x, y1, bw5, bh5, "LOCKOUT\nOnly /api/me\n/api/billing/*")
x += bw5 + Inches(0.3)
b6 = process_box(slide, x, y1, bw5, bh5, "Show Upgrade\nUI in\nDashboard", border=ORANGE)

add_arrow_connector(slide, right_edge(b1), cy(b1), left_edge(b2), cy(b2), INDIGO)
add_arrow_connector(slide, right_edge(b2), cy(b2), left_edge(b3), cy(b3), INDIGO)
add_arrow_connector(slide, right_edge(b3), cy(b3), left_edge(b4), cy(b4), INDIGO)
add_arrow_connector(slide, right_edge(b4), cy(b4), left_edge(b5), cy(b5), ORANGE)
add_label(slide, right_edge(b4) + Inches(0.02), cy(b4) - Inches(0.25), "Yes", 9, ORANGE, Inches(0.5))
add_arrow_connector(slide, right_edge(b5), cy(b5), left_edge(b6), cy(b6), ORANGE)

# Active trial path
b4_ok = process_box(slide, left_edge(b4) - Inches(0.1), y1 + Inches(1.3), Inches(1.5), Inches(0.5), "Continue\nUsing App", border=GREEN)
add_arrow_connector(slide, cx(b4), bottom(b4), cx(b4_ok), top_edge(b4_ok), GREEN)
add_label(slide, cx(b4) - Inches(0.5), bottom(b4) + Inches(0.02), "No", 9, GREEN, Inches(0.5))

# Row 2: Checkout flow
y2 = Inches(3.3)
x = Inches(0.3)
b7 = process_box(slide, x, y2, bw5, bh5, "POST\n/api/billing\n/checkout", border=INDIGO)
x += bw5 + Inches(0.3)
b8 = decision_box(slide, x, y2, Inches(1.4), Inches(1.0), "Existing\nStripe\nCustomer?", border=ORANGE)
x += Inches(1.4) + Inches(0.3)
b9 = process_box(slide, x, y2, bw5, bh5, "Create Stripe\nCheckout\nSession", border=INDIGO)
x += bw5 + Inches(0.3)
b10 = process_box(slide, x, y2, bw5, bh5, "302 Redirect\nto Stripe\nHosted Page", border=INDIGO)
x += bw5 + Inches(0.3)
b11 = process_box(slide, x, y2, bw5, bh5, "User Completes\nPayment\n(Pro/Agency)", border=GREEN)
x += bw5 + Inches(0.3)
b12 = success_box(slide, x, y2, bw5, bh5, "Redirect to\n/dashboard\n?billing=success")

add_arrow_connector(slide, cx(b6), bottom(b6), cx(b7), top_edge(b7), ORANGE)
add_arrow_connector(slide, right_edge(b7), cy(b7), left_edge(b8), cy(b8), INDIGO)
add_arrow_connector(slide, right_edge(b8), cy(b8), left_edge(b9), cy(b9), INDIGO)
add_arrow_connector(slide, right_edge(b9), cy(b9), left_edge(b10), cy(b10), INDIGO)
add_arrow_connector(slide, right_edge(b10), cy(b10), left_edge(b11), cy(b11), GREEN)
add_arrow_connector(slide, right_edge(b11), cy(b11), left_edge(b12), cy(b12), GREEN)

# Row 3: Webhook processing
y3 = Inches(4.8)
x = Inches(0.3)
b13 = process_box(slide, x, y3, bw5, bh5, "POST /api\n/webhooks/stripe\n(Signature Verify)", border=INDIGO)
x += bw5 + Inches(0.3)
b14 = process_box(slide, x, y3, Inches(2.0), bh5, "checkout.session\n.completed\nLink Customer ID", border=GREEN)
x += Inches(2.0) + Inches(0.3)
b15 = process_box(slide, x, y3, Inches(2.0), bh5, "subscription\n.created/updated\nSet plan in D1", border=GREEN)
x += Inches(2.0) + Inches(0.3)
b16 = success_box(slide, x, y3, bw5, bh5, "Plan = pro\nor agency\nFeatures unlock")
x += bw5 + Inches(0.3)
b17 = data_store(slide, x, y3, bw5, bh5, "D1: users,\nsubscriptions,\nbilling_events")

add_arrow_connector(slide, cx(b11), bottom(b11), cx(b13), top_edge(b13), GREEN)
add_arrow_connector(slide, right_edge(b13), cy(b13), left_edge(b14), cy(b14), GREEN)
add_arrow_connector(slide, right_edge(b14), cy(b14), left_edge(b15), cy(b15), GREEN)
add_arrow_connector(slide, right_edge(b15), cy(b15), left_edge(b16), cy(b16), GREEN)
add_arrow_connector(slide, right_edge(b16), cy(b16), left_edge(b17), cy(b17), INDIGO)

# Row 4: Cancellation / failure
y4 = Inches(5.9)
x = Inches(0.3)
b18 = error_box(slide, x, y4, bw5, bh5, "invoice.payment\n_failed")
x += bw5 + Inches(0.3)
b19 = process_box(slide, x, y4, bw5, bh5, "Status =\npast_due", border=RED)
x += bw5 + Inches(0.3)
b20 = error_box(slide, x, y4, bw5, bh5, "subscription\n.deleted")
x += bw5 + Inches(0.3)
b21 = process_box(slide, x, y4, bw5, bh5, "Downgrade\nplan = 'trial'\nStripe sub = NULL", border=RED)

add_arrow_connector(slide, right_edge(b18), cy(b18), left_edge(b19), cy(b19), RED)
add_arrow_connector(slide, right_edge(b20), cy(b20), left_edge(b21), cy(b21), RED)

# Plan details boxes
x = Inches(7.0)
plans_data = [
    ("Trial (Free)", ["1 site", "SEO audit + Performance", "7-day duration", "No integrations"], BORDER_COLOR),
    ("Pro ($29/mo)", ["5 sites", "Google + Cloudflare", "Search Console + GA4", "AI suggestions"], GREEN),
    ("Agency ($59/mo)", ["25 sites", "Everything in Pro", "Team collaboration", "Priority support"], PURPLE),
]
for i, (title, features, border) in enumerate(plans_data):
    px = x + i * Inches(2.2)
    pb = add_shape(slide, px, y4, Inches(2.0), Inches(1.3), CARD_COLOR, border)
    add_multiline_text(pb, [title] + features, 9, TEXT_COLOR, True, PP_ALIGN.LEFT)


# ============================================================================
# SLIDE 7: Team Collaboration Flow
# ============================================================================
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide)
add_title(slide, "6. Team Collaboration Flow", "Invite > Magic link accept > Role-based access > Shared dashboard")

bw6 = Inches(1.7)
bh6 = Inches(0.65)

# Row 1: Invite flow
y1 = Inches(1.8)
x = Inches(0.3)
t1 = start_end(slide, x, y1, bw6, bh6, "Admin User\n(Agency Plan)")
x += bw6 + Inches(0.3)
t2 = decision_box(slide, x, y1, Inches(1.3), Inches(0.95), "Plan =\nAgency?", border=ORANGE)
x += Inches(1.3) + Inches(0.3)
t3 = process_box(slide, x, y1, bw6, bh6, "POST\n/api/team/invite\nmember_email", border=INDIGO)
x += bw6 + Inches(0.3)
t4 = process_box(slide, x, y1, bw6, bh6, "Generate\ninvite_token\n(UUID, 7d TTL)", border=INDIGO)
x += bw6 + Inches(0.3)
t5 = process_box(slide, x, y1, bw6, bh6, "Store in D1:\nteam_members\ntable", border=INDIGO)
x += bw6 + Inches(0.3)
t6 = process_box(slide, x, y1, bw6, bh6, "Send Invite\nEmail via\nBrevo", border=GREEN)

add_arrow_connector(slide, right_edge(t1), cy(t1), left_edge(t2), cy(t2), INDIGO)
t2_no = gated_box(slide, left_edge(t2) - Inches(0.05), y1 + Inches(1.2), Inches(1.4), Inches(0.5), "Requires\nAgency Plan")
add_arrow_connector(slide, cx(t2), bottom(t2), cx(t2_no), top_edge(t2_no), ORANGE)
add_label(slide, cx(t2) + Inches(0.15), bottom(t2) + Inches(0.02), "No", 9, ORANGE, Inches(0.5))

add_arrow_connector(slide, right_edge(t2), cy(t2), left_edge(t3), cy(t3), GREEN)
add_label(slide, right_edge(t2) + Inches(0.02), cy(t2) - Inches(0.22), "Yes", 9, GREEN, Inches(0.5))
add_arrow_connector(slide, right_edge(t3), cy(t3), left_edge(t4), cy(t4), INDIGO)
add_arrow_connector(slide, right_edge(t4), cy(t4), left_edge(t5), cy(t5), INDIGO)
add_arrow_connector(slide, right_edge(t5), cy(t5), left_edge(t6), cy(t6), GREEN)

# Row 2: Accept flow
y2 = Inches(3.3)
x = Inches(0.3)
t7 = process_box(slide, x, y2, bw6, bh6, "Invitee Clicks\nEmail Link", border=GREEN)
x += bw6 + Inches(0.3)
t8 = process_box(slide, x, y2, bw6, bh6, "GET /api/team\n/accept?token=X", border=INDIGO)
x += bw6 + Inches(0.3)
t9 = decision_box(slide, x, y2, Inches(1.3), Inches(0.95), "Has\nAccount?", border=ORANGE)
x += Inches(1.3) + Inches(0.3)

# No account - signup first
t9_no = process_box(slide, left_edge(t9) - Inches(0.05), y2 + Inches(1.2), Inches(1.4), Inches(0.5), "Magic Link\nSignup First", border=INDIGO)
add_arrow_connector(slide, cx(t9), bottom(t9), cx(t9_no), top_edge(t9_no), INDIGO)
add_label(slide, cx(t9) + Inches(0.15), bottom(t9) + Inches(0.02), "No", 9, INDIGO, Inches(0.5))

t10 = process_box(slide, x, y2, bw6, bh6, "Validate Token\n(not expired,\nnot used)", border=INDIGO)
x += bw6 + Inches(0.3)
t11 = process_box(slide, x, y2, bw6, bh6, "Set\nmember_user_id\naccepted_at", border=GREEN)
x += bw6 + Inches(0.3)
t12 = success_box(slide, x, y2, bw6, bh6, "Redirect to\n/dashboard\n(Owner's Data)")

add_arrow_connector(slide, cx(t6), bottom(t6), cx(t7), top_edge(t7), GREEN)
add_arrow_connector(slide, right_edge(t7), cy(t7), left_edge(t8), cy(t8), INDIGO)
add_arrow_connector(slide, right_edge(t8), cy(t8), left_edge(t9), cy(t9), INDIGO)
add_arrow_connector(slide, right_edge(t9), cy(t9), left_edge(t10), cy(t10), GREEN)
add_label(slide, right_edge(t9) + Inches(0.02), cy(t9) - Inches(0.22), "Yes", 9, GREEN, Inches(0.5))
add_arrow_connector(slide, right_edge(t10), cy(t10), left_edge(t11), cy(t11), GREEN)
add_arrow_connector(slide, right_edge(t11), cy(t11), left_edge(t12), cy(t12), GREEN)

# Row 3: Role-based access
y3 = Inches(5.0)
x = Inches(0.3)
r1 = process_box(slide, x, y3, Inches(2.5), Inches(1.0), "resolveEffectiveUser()\nIf team member:\neffectiveUserId =\nowner_user_id", border=INDIGO)
x += Inches(2.5) + Inches(0.4)
r2 = add_shape(slide, x, y3, Inches(3.5), Inches(1.0), CARD_COLOR, GREEN)
add_multiline_text(r2, [
    "Admin Role (Owner):",
    "Add/remove websites",
    "Manage integrations",
    "Invite/remove team members",
    "Access billing"
], 9, TEXT_COLOR, True, PP_ALIGN.LEFT)
x += Inches(3.5) + Inches(0.4)
r3 = add_shape(slide, x, y3, Inches(3.5), Inches(1.0), CARD_COLOR, ORANGE)
add_multiline_text(r3, [
    "Member Role (Invitee):",
    "View all dashboards",
    "View audit results",
    "Cannot add/remove sites",
    "Cannot modify integrations"
], 9, TEXT_COLOR, True, PP_ALIGN.LEFT)
x += Inches(3.5) + Inches(0.4)
r4 = add_shape(slide, x, y3, Inches(2.5), Inches(1.0), CARD_COLOR, BORDER_COLOR)
add_multiline_text(r4, [
    "Data Access:",
    "All queries scoped to",
    "effectiveUserId",
    "(owner's properties)",
    "Team members see all"
], 9, TEXT_MUTED, True, PP_ALIGN.LEFT)


# ============================================================================
# SLIDE 8: System Architecture Overview
# ============================================================================
slide = prs.slides.add_slide(prs.slide_layouts[6])
set_slide_bg(slide)
add_title(slide, "7. System Architecture Overview", "Cloudflare Workers SaaS — Routes, Storage, External APIs")

# Left column: Request routing
col1_x = Inches(0.3)
col1_w = Inches(3.5)
y = Inches(1.5)
h1 = add_shape(slide, col1_x, y, col1_w, Inches(0.45), INDIGO, INDIGO)
add_text_to_shape(h1, "Cloudflare Worker (index.js)", 12, WHITE, True)
y += Inches(0.55)
routes = [
    "/ - Marketing (marketing.html)",
    "/login - Login page (login.html)",
    "/dashboard - SPA (dashboard.html)",
    "/api/auth/* - Magic link auth",
    "/api/properties/* - CRUD",
    "/api/data - Portfolio/detail",
    "/api/performance - CWV + GA4 + CF",
    "/api/seo-stats - SEO issues",
    "/api/accessibility - A11y",
    "/api/keywords - Search Console",
    "/api/ai-readiness - AI readiness",
    "/api/billing/* - Stripe billing",
    "/api/team/* - Team management",
    "/api/oauth/google/* - OAuth",
    "/api/webhooks/stripe - Webhooks",
]
for route in routes:
    rb = add_shape(slide, col1_x, y, col1_w, Inches(0.28), DARK_CARD, BORDER_COLOR)
    add_text_to_shape(rb, route, 8, TEXT_MUTED, False, PP_ALIGN.LEFT)
    y += Inches(0.3)

# Middle column: Storage
col2_x = Inches(4.1)
col2_w = Inches(3.0)
y = Inches(1.5)
h2 = add_shape(slide, col2_x, y, col2_w, Inches(0.45), PURPLE, PURPLE)
add_text_to_shape(h2, "Storage Layer", 12, WHITE, True)
y += Inches(0.65)

d1_box = data_store(slide, col2_x, y, col2_w, Inches(1.0), "D1 (SQLite)")
y += Inches(1.15)
d1_tables = add_shape(slide, col2_x, y, col2_w, Inches(2.0), DARK_CARD, BORDER_COLOR)
add_multiline_text(d1_tables, [
    "users", "properties", "audits", "issues",
    "broken_links", "accessibility_issues",
    "ai_readiness_issues", "keywords",
    "performance_snapshots",
    "performance_history",
    "subscriptions", "billing_events",
    "team_members", "magic_links",
    "oauth_states"
], 8, TEXT_MUTED, False, PP_ALIGN.LEFT)

y += Inches(2.15)
kv_box = data_store(slide, col2_x, y, col2_w, Inches(0.7), "KV (SEO_AUDITS)")
y += Inches(0.85)
kv_detail = add_shape(slide, col2_x, y, col2_w, Inches(0.6), DARK_CARD, BORDER_COLOR)
add_multiline_text(kv_detail, [
    "session:{id} - 30d TTL",
    "audit:{user}:{domain} - cache",
    "quickaudit:{user}:{domain}"
], 8, TEXT_MUTED, False, PP_ALIGN.LEFT)

# Right column: External APIs
col3_x = Inches(7.4)
col3_w = Inches(2.8)
y = Inches(1.5)
h3 = add_shape(slide, col3_x, y, col3_w, Inches(0.45), GREEN, GREEN)
add_text_to_shape(h3, "External APIs", 12, WHITE, True)
y += Inches(0.65)

apis = [
    ("Google GA4 Data API", "Analytics reporting", INDIGO),
    ("Google Search Console", "Keywords, indexing", INDIGO),
    ("Google Admin API", "GA4 property discovery", INDIGO),
    ("PageSpeed Insights", "CrUX + Lighthouse", GREEN),
    ("Cloudflare GraphQL", "Traffic, cache, WAF", INDIGO),
    ("Stripe API", "Checkout, subscriptions", ORANGE),
    ("Brevo API", "Magic link emails", INDIGO),
    ("Workers AI", "Fix suggestions", PURPLE),
]

for name, desc, color in apis:
    ab = add_shape(slide, col3_x, y, col3_w, Inches(0.55), CARD_COLOR, color)
    add_multiline_text(ab, [name, desc], 9, TEXT_COLOR, True, PP_ALIGN.LEFT)
    y += Inches(0.62)

# Far right: Source files
col4_x = Inches(10.5)
col4_w = Inches(2.6)
y = Inches(1.5)
h4 = add_shape(slide, col4_x, y, col4_w, Inches(0.45), BORDER_COLOR, BORDER_COLOR)
add_text_to_shape(h4, "Source Files", 12, TEXT_COLOR, True)
y += Inches(0.65)

files = [
    "index.js - Router + handlers",
    "handlers.js - Data endpoints",
    "audit.js - Full sitemap audit",
    "quick-audit.js - Homepage audit",
    "google-api.js - GA4 + SC + PSI",
    "google-oauth.js - OAuth + encrypt",
    "google-auth.js - Token refresh",
    "auth.js - Magic link + sessions",
    "stripe.js - Billing + webhooks",
    "tenant.js - Multi-tenant + teams",
    "cloudflare-api.js - CF GraphQL",
    "config.js - Legacy credentials",
    "utils.js - Date ranges, helpers",
    "dashboard.html - Frontend SPA",
    "marketing.html - Landing page",
]

for f in files:
    fb = add_shape(slide, col4_x, y, col4_w, Inches(0.28), DARK_CARD, BORDER_COLOR)
    add_text_to_shape(fb, f, 8, TEXT_MUTED, False, PP_ALIGN.LEFT)
    y += Inches(0.3)


# ============================================================================
# SAVE
# ============================================================================
output_path = '/Users/roberttorres/Documents/websites/webhealthdashboard/Shelob-Web-System-Flow-Diagrams.pptx'
prs.save(output_path)
print(f'Saved to {output_path}')
