-- ============================================================================
-- Migration 031: Submissions — proxy_video_url column
--
-- Adds a `proxy_video_url text` column to the submissions table.
-- When a GLB/3D model is submitted, the GLB turntable renderer (Railway worker)
-- writes the URL of the rendered MP4 here. The reviews UI uses this for preview.
--
-- The asset-sanitizer edge function populates this column after successful
-- GLB → MP4 conversion. It is NULL for non-3D submissions.
-- ============================================================================

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS proxy_video_url text;

COMMENT ON COLUMN public.submissions.proxy_video_url IS
  'URL of the proxy MP4 turntable video for GLB/3D model submissions. NULL for non-3D files.';
