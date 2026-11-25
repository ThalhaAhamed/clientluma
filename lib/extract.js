// Turn uploaded client documents into plain text for the knowledge base.
import { extractText } from "unpdf";
import mammoth from "mammoth";

const TEXT_EXT = /\.(txt|md|csv|json|html?|eml|xml|tsv)$/i;

/** @param {string} name file name  @param {Buffer} buf file bytes */
export async function extractDocText(name, buf) {
  if (/\.pdf$/i.test(name)) {
    const { text } = await extractText(new Uint8Array(buf), { mergePages: true });
    return text;
  }
  if (/\.docx$/i.test(name)) {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (TEXT_EXT.test(name)) {
    const text = buf.toString("utf8");
    return /\.html?$/i.test(name) ? text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ") : text;
  }
  throw new Error(`Unsupported file type: ${name}. Use PDF, DOCX or a text format.`);
}
