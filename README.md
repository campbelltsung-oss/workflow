# Look Lab

A browser tool for editing images with reusable color & tone filters. Each filter is learned from a single reference photo.

Everything runs locally in the browser. Images are never uploaded.

## Use it

Open `index.html` in a browser. There's no build step and nothing to install.

1. **Make a filter.** Click **New filter from reference**, pick a photo whose look you want, name it, and save.
2. **Add images.** Drop images onto the page or click **Add images**.
3. **Pick a filter per image**, or use **Set every image to** to apply one to all of them.
4. **Adjust** the *Tone* and *Color* strength sliders, and drag across the preview to compare before and after.
5. **Save** one image, or **Save all** as a zip.

Filters are kept in the browser's local storage. Use **Export filters** / **Import filters** to back them up or share them as a `.json` file.

## How a filter is learned

`filter-engine.js` works in CIE Lab color space:

- **Tone** stores 256 quantiles of the reference's lightness. Applying a filter matches the image's lightness distribution to them, smoothed and kept monotonic so it acts like a tone curve.
- **Color** stores the average tint and color spread of the reference in three tonal zones: shadows, midtones and highlights. Zones are defined by rank, so the darkest third of your image is graded like the darkest third of the reference. This captures split toning, such as teal shadows with warm highlights.

Output keeps the original resolution. PNG inputs are saved as PNG and everything else as JPEG (quality 92). EXIF metadata is not carried over.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout and styles |
| `app.js` | UI: filter library, image cards, previews, saving |
| `filter-engine.js` | Color analysis and filter application (works in the browser and Node) |
| `test/` | Engine tests: `npm test` |
