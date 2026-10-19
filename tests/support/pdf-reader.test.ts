// The test PDF reader must itself be strict, or the writer tests prove
// nothing: a file with a wrong xref offset, a wrong stream /Length or an
// exponent number is rejected.
import { describe, expect, it } from 'vitest';
import { readContent, readPdf } from './pdf-reader';

const enc = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

/** A tiny hand-made PDF in our writer's layout (objects, xref, trailer). */
function tinyPdf(options: { shift?: number; length?: number } = {}): Uint8Array {
  const header = '%PDF-1.7\n%\u{E2}\u{E3}\u{CF}\u{D3}\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${options.length ?? 2} >>\nstream\nBT\nendstream\nendobj\n`,
    '5 0 obj\n<< /Title <FEFF0041> /Producer <FEFF0042> >>\nendobj\n',
  ];
  let body = header;
  const offsets: number[] = [];
  for (const o of objects) {
    offsets.push(body.length);
    body += o;
  }
  const xrefAt = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n`;
  for (const [i, off] of offsets.entries()) body += `${String(off + (i === 2 ? (options.shift ?? 0) : 0)).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size 6 /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return enc(body);
}

describe('test PDF reader', () => {
  it('reads a well-formed file', () => {
    const pdf = readPdf(tinyPdf());
    expect(pdf.pages()).toHaveLength(1);
  });

  it('rejects an xref offset that does not point at "N 0 obj"', () => {
    expect(() => readPdf(tinyPdf({ shift: 1 }))).toThrow(/does not point/);
  });

  it('rejects a wrong stream /Length', () => {
    expect(() => readPdf(tinyPdf({ length: 3 }))).toThrow(/Length does not match/);
  });

  it('rejects exponent notation and unknown operators in content', () => {
    expect(() => readContent('1e-7 w')).toThrow(/exponent/);
    expect(() => readContent('(x) Tj')).toThrow(/Tj/);
    expect(() => readContent('BT /F1 1 Tf 0 0 Td ET')).toThrow(/unexpected operator Td/);
  });
});
