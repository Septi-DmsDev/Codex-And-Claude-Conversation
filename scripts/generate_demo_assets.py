from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
DOCS.mkdir(exist_ok=True)


def load_font(size: int, bold: bool = False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/Library/Fonts/Arial.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def ensure_placeholder_screenshot(path: Path, title: str, accent: tuple[int, int, int]):
    if path.exists():
        return Image.open(path).convert("RGB")
    img = Image.new("RGB", (1440, 900), "#081119")
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((42, 42, 1398, 858), radius=36, fill="#0f1720", outline="#1f2937", width=2)
    draw.rounded_rectangle((72, 98, 420, 820), radius=28, fill="#111f2b")
    draw.rounded_rectangle((444, 98, 1020, 820), radius=28, fill="#111f2b")
    draw.rounded_rectangle((1046, 98, 1368, 820), radius=28, fill="#111f2b")
    draw.rounded_rectangle((72, 72, 1368, 116), radius=18, fill=accent)
    font_title = load_font(48, bold=True)
    font_body = load_font(28)
    draw.text((102, 170), title, font=font_title, fill="#ecf7f3")
    draw.text((102, 238), "Drop your latest dashboard screenshot here to replace this placeholder.", font=font_body, fill="#a9c0ba")
    img.save(path)
    return img


def create_social_preview(logo_path: Path):
    img = Image.new("RGB", (1280, 640), "#081119")
    draw = ImageDraw.Draw(img)
    title_font = load_font(58, bold=True)
    body_font = load_font(28)
    pill_font = load_font(22)

    draw.rounded_rectangle((58, 58, 1222, 582), radius=42, fill="#0f1720", outline="#1f2937", width=2)
    draw.rounded_rectangle((86, 88, 198, 200), radius=28, fill="#0F766E")
    draw.text((110, 108), "CB", font=load_font(54, bold=True), fill="white")
    draw.text((228, 96), "Context Bridge", font=title_font, fill="#ecf7f3")
    draw.text((228, 168), "Codex & Claude Conversation Sync Dashboard", font=body_font, fill="#d4e7e1")
    draw.text((88, 268), "A local-first dashboard for safe AI context reuse.", font=body_font, fill="#d4e7e1")
    draw.text((88, 314), "Includes project-scoped context guardrails, sync controls, starter packs, and dark mode.", font=body_font, fill="#9cb6b1")

    x = 88
    for label, color in [
        ("Context Guard", "#0F766E"),
        ("Dark Mode", "#2563EB"),
        ("Starter Packs", "#B45309"),
        ("GitHub Actions", "#7C3AED"),
    ]:
        text_box = draw.textbbox((0, 0), label, font=pill_font)
        width = text_box[2] - text_box[0] + 32
        draw.rounded_rectangle((x, 408, x + width, 454), radius=23, fill=color)
        draw.text((x + 16, 419), label, font=pill_font, fill="white")
        x += width + 12

    if logo_path.exists():
        try:
            logo = Image.open(logo_path).convert("RGBA")
            logo.thumbnail((220, 220))
            img.paste(logo, (970, 120), logo)
        except Exception:
            pass

    img.save(DOCS / "social-preview.png")


def create_demo_gif(dashboard: Image.Image, command: Image.Image):
    frames = []
    canvas_size = (1280, 720)
    title_font = load_font(38, bold=True)
    body_font = load_font(22)

    slides = [
        (dashboard.resize(canvas_size), "Browse conversations safely", "Filter by project, source, and AI access."),
        (command.resize(canvas_size), "Run starter packs", "Launch backfill, sync, watch, and recovery flows."),
        (dashboard.resize(canvas_size), "Protect AI context", "Allow only the conversations that belong to the active project."),
    ]

    for image, title, subtitle in slides:
        frame = image.convert("RGBA")
        overlay = Image.new("RGBA", canvas_size, (8, 17, 25, 0))
        draw = ImageDraw.Draw(overlay)
        draw.rounded_rectangle((28, 520, 1252, 684), radius=28, fill=(8, 17, 25, 210))
        draw.text((62, 552), title, font=title_font, fill="#ecf7f3")
        draw.text((62, 606), subtitle, font=body_font, fill="#b6ccc7")
        frame = Image.alpha_composite(frame, overlay)
        frames.extend([frame.convert("P", palette=Image.ADAPTIVE)] * 12)

    frames[0].save(
        DOCS / "demo.gif",
        save_all=True,
        append_images=frames[1:],
        duration=220,
        loop=0,
        optimize=False,
    )


def main():
    dashboard = ensure_placeholder_screenshot(DOCS / "screenshot-dashboard.png", "Dashboard Preview", (15, 118, 110))
    command = ensure_placeholder_screenshot(DOCS / "screenshot-command-center.png", "Command Center Preview", (180, 83, 9))
    create_social_preview(DOCS / "logo.svg")
    create_demo_gif(dashboard, command)
    print("Generated docs/social-preview.png and docs/demo.gif")


if __name__ == "__main__":
    main()
