// One call from the included emails to the PDF file: the document model
// (model.ts), the layout with the index page numbers, links and bookmarks
// (page-layout/), and the backend (pdf-writer/). This is what the PDF worker runs.
//
// Pure apart from the time it takes: no DOM, no clock (the caller passes
// `generatedAt`), no storage, no globals, nothing loaded (README.md, rules
// R1, R5, R7), so it is safe in a Web Worker. The fonts are parsed once by
// the caller (loadPdfFonts, load-fonts.ts) and passed in. Email text is
// only ever written as text in the PDF (rule R4); the plans decide what is
// left out (rule R6, the exception for the PDF), nothing here changes that.
import { layoutPdf } from './page-layout';
import { buildPdfDocument } from './model';
import { createPdfStrings } from './strings';
import { OwnPdfWriter } from './pdf-writer';
import type { LayoutConfig, PdfBackend } from '../../Header/laid-out-document';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { GeneratedPdf, PdfStrings } from '../../Header/pdf-document-model';
import type { ParsedFont, PdfFontName } from '../../Header/pdf-fonts';
import type { EngineResult } from '../../Header/thread-analysis-result';

/** The four parsed PDF fonts (loadPdfFonts). */
export type PdfFonts = Readonly<Record<PdfFontName, ParsedFont>>;

export interface GeneratePdfInput
{
    readonly result: EngineResult;
    /** List positions of the included emails, in list order (Source/page/pdf-labels.ts, PdfPlans). */
    readonly positions: readonly number[];
    /** One plan per position, same order. */
    readonly plans: readonly MessagePlan[];
    /** Ids of the rebuilt emails chosen (Source/page/review.ts, includedRebuilt); absent or [] for none. See BuildPdfInput.rebuilt. */
    readonly rebuilt?: readonly number[];
    /** True when "Rebuild conversation from replies" is off. See BuildPdfInput.rebuildingOff. */
    readonly rebuildingOff?: boolean;
    /** Ids of the rebuilt emails the reader unticked (Source/page/review.ts, untickedRebuilt). See BuildPdfInput.unticked. */
    readonly unticked?: readonly number[];
    readonly policy: OutputPolicy;
    /** IANA zone the dates are shown in (an invalid one falls back to UTC; the cover then names UTC). */
    readonly timeZone: string;
    /** When the PDF is made, in ms since 1970 UTC. */
    readonly generatedAt: number;
    readonly fonts: PdfFonts;
    /** The PDF's language (a language the page ships, e.g. 'en'): its words and its file name. */
    readonly locale: string;
    /** The fixed texts (default: createPdfStrings(locale)). Tests may pass their own. */
    readonly strings?: PdfStrings;
    /** The look (default: the layout's DEFAULT_LAYOUT_CONFIG). */
    readonly config?: LayoutConfig;
    /** The backend (default: our own writer). */
    readonly backend?: PdfBackend;
}

/**
 * Makes the PDF. Rejects with an Error when the layout cannot be made (see
 * layoutPdf) or the backend fails (a PdfWriteError from our own writer,
 * e.g. a size limit reached).
 */
export async function generatePdf(input: GeneratePdfInput): Promise<GeneratedPdf>
{
    const strings = input.strings ?? createPdfStrings(input.locale);
    const doc = buildPdfDocument({
        result: input.result,
        positions: input.positions,
        plans: input.plans,
        ...(input.rebuilt === undefined ? {} : { rebuilt: input.rebuilt }),
        ...(input.rebuildingOff === undefined ? {} : { rebuildingOff: input.rebuildingOff }),
        ...(input.unticked === undefined ? {} : { unticked: input.unticked }),
        policy: input.policy,
        timeZone: input.timeZone,
        generatedAt: input.generatedAt,
        strings,
    });
    const { document } = layoutPdf(doc, input.fonts, { strings, ...(input.config === undefined ? {} : { config: input.config }) });
    const bytes = await (input.backend ?? new OwnPdfWriter()).render(document, input.fonts);
    return { bytes, fileName: doc.fileName, pageCount: document.pages.length };
}
