import { contentDispositionHeader } from "@/lib/artifact-naming";

/**
 * The headers stored with every exam paper's PDF in R2, which R2 sends
 * back whenever the file is downloaded straight from it (through a
 * temporary presigned link). Used both when a paper is first ingested and
 * by the CLI's set-disposition command for papers stored before this
 * existed -- so every stored PDF ends up with exactly the same headers.
 */
export interface ServingHeaders {
  contentType: string;
  contentDisposition: string;
  cacheControl: string;
}

/**
 * "private" means only the visitor's own browser may keep a copy (no
 * shared cache in between); "max-age=600" lets it reuse that copy for 10
 * minutes -- the same window a presigned link stays valid -- instead of
 * downloading the paper again, e.g. when going back to it.
 */
export const PDF_CACHE_CONTROL = "private, max-age=600";

/**
 * How long a presigned link to a paper (handed out by /api/files) stays
 * valid. This is also the longest a paper can stay downloadable after
 * being unpublished, for someone who requested it just before -- the
 * agreed "up to ~10 minutes".
 */
export const PRESIGNED_LINK_SECONDS = 600;

export function pdfServingHeaders(title: string): ServingHeaders {
  return {
    contentType: "application/pdf",
    contentDisposition: contentDispositionHeader("inline", title),
    cacheControl: PDF_CACHE_CONTROL,
  };
}
