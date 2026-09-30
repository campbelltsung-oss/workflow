# Look Lab

A browser tool for editing images. Claude can correct each photo (AI enhance), and reusable color & tone filters, each learned from a single reference photo, give images a consistent look.

All pixel editing runs locally in the browser at full resolution. AI enhance sends Claude a downsized preview (about 1.2 MP) and gets back adjustment settings, never pixels.

## Use it

Open `index.html` in a browser. There's no build step and nothing to install.

1. **Make a filter.** Click **New filter from reference**, pick a photo whose look you want, name it, and save.
2. **Add images.** Drop images onto the page or click **Add images**.
3. **Enhance with AI** (optional). Claude looks at the photo and sets the *Adjustments* sliders: exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance and saturation. Choose an **Aim** (Natural, Polished, Bold) in the toolbar. **Refine** shows Claude the original next to its edit so it can fine-tune. **Enhance all with AI** runs through every image. You can adjust any slider by hand afterward.
4. **Pick a filter per image**, or use **Set every image to** to apply one to all of them.
5. **Adjust** the *Tone* and *Color* strength sliders, and drag across the preview to compare before and after.
6. **Save** one image, or **Save all** as a zip.

Filters are kept in the browser's local storage. Use **Export filters** / **Import filters** to back them up or share them as a `.json` file.

## AI enhance

AI enhance uses the `sample` capability of Claude artifacts, so it works when Look Lab is opened as a Claude artifact and uses the viewer's own Claude usage. The first use asks for permission. When the page is opened straight from disk, the AI buttons are hidden and everything else works.

For each image, Claude receives the preview plus measurements the engine takes: lightness percentiles, clipping, the color cast in shadows, midtones and highlights, and colorfulness. It replies with JSON settings, which are clamped to the slider ranges. The adjustments run before the filter, so a look is matched against the corrected image.

## How a filter is learned

`filter-engine.js` works in CIE Lab color space:

- **Tone** stores 256 quantiles of the reference's lightness. Applying a filter matches the image's lightness distribution to them, smoothed and kept monotonic so it acts like a tone curve.
- **Color** stores the average tint and color spread of the reference in three tonal zones: shadows, midtones and highlights. Zones are defined by rank, so the darkest third of your image is graded like the darkest third of the reference. This captures split toning, such as teal shadows with warm highlights.

Output keeps the original resolution. PNG inputs are saved as PNG and everything else as JPEG (quality 92). EXIF metadata is not carried over.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout and styles |
| `app.js` | UI: filter library, image cards, adjustments, AI enhance, previews, saving |
| `filter-engine.js` | Color analysis, base adjustments and filter application (works in the browser and Node) |
| `test/` | Engine tests: `npm test` |
