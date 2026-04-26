# GLB Turntable Worker — Railway

Renders GLB files as MP4 turntable videos using headless Three.js.

## Architecture

```
GLB file (POST) → Three.js headless render → MP4 encode → Supabase Storage → URL
```

## Dependencies

- `three` — WebGL rendering
- `gl` (npm) — headless WebGL for Node.js
- `mp4-muxer` — pure-JS MP4 encoding (no ffmpeg dependency)

## Environment Variables

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
STORAGE_BUCKET=submissions
```

## Deploy

```bash
railway up --product=worker
```

## Implementation Notes

- Renderer: use `@sparticuz/chromium` or `playwright` for full headless Chrome + WebGL
- MP4 encoding: use `mp4-muxer` npm package (avoids ffmpeg dependency)
- RAM: request 2GB minimum in `railway.json` for large GLB files
