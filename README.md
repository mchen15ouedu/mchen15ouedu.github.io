# Mengye Chen Personal Website

This is a simple static personal website for `mcspace.work`.

## Files

- `index.html` — main website
- `styles.css` — visual styling
- `script.js` — mobile navigation and footer year
- `favicon.svg` — browser icon
- `CNAME` — custom domain file for GitHub Pages

## Recommended deployment option: GitHub Pages

1. Create a GitHub repository, for example `mcspace.work`.
2. Upload all files in this folder to the repository root.
3. Go to repository **Settings → Pages**.
4. Set the source to the `main` branch and root folder.
5. In the custom domain field, enter:

```text
mcspace.work
```

6. In Cloudflare DNS, point `mcspace.work` to your GitHub Pages site following GitHub's current custom-domain instructions.
7. Turn on HTTPS after GitHub verifies the domain.

## Alternative: Cloudflare Pages

Because the domain was purchased on Cloudflare, Cloudflare Pages is also a good option.

1. Create a new Cloudflare Pages project.
2. Upload this folder or connect a GitHub repo.
3. Set the build command to blank / none.
4. Set the output directory to `/` or leave default for static upload.
5. Add the custom domain `mcspace.work`.

## Notes to customize

Search for the following placeholders or sections and update them:

- Google Scholar link: https://scholar.google.com/citations?user=ry1Lq94AAAAJ&hl=en
- LinkedIn link
- Full publication list
- Any preferred professional email
- Add a PDF CV link if you want to host `cv.pdf`
