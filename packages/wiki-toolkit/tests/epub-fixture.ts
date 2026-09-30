// SPDX-License-Identifier: Apache-2.0
import { zipSync, strToU8 } from 'fflate';
const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function epubFixture(
  text: string,
  options: { version?: '2.0' | '3.0'; encryption?: 'font' | 'content'; markup?: string } = {},
) {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OPS/book.opf': strToU8(
      `<package xmlns="http://www.idpf.org/2007/opf" version="${options.version ?? '3.0'}"><metadata/><manifest><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="font" href="font.otf" media-type="font/otf"/></manifest><spine><itemref idref="c1" id="one"/><itemref idref="c2"/></spine></package>`,
    ),
    'OPS/c1.xhtml': strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body id="body"><p id="p[a],b">${options.markup ?? escape(text)}</p><script>DO NOT RUN</script></body></html>`,
    ),
    'OPS/c2.xhtml': strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p>Second spine item.</p></body></html>',
    ),
    'OPS/nav.xhtml': strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><nav><a href="c1.xhtml">Chapter one</a><a href="c2.xhtml">Chapter two</a></nav></body></html>',
    ),
    'OPS/font.otf': new Uint8Array([1, 2, 3]),
  };
  if (options.encryption)
    files['META-INF/encryption.xml'] = strToU8(
      `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherData><CipherReference URI="OPS/${options.encryption === 'font' ? 'font.otf' : 'c1.xhtml'}"/></CipherData></EncryptedData></encryption>`,
    );
  if (options.version === '2.0') {
    const opf = new TextDecoder().decode(files['OPS/book.opf']);
    files['OPS/book.opf'] = strToU8(
      opf
        .replace(
          '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
          '<item id="ncx" href="nav.ncx" media-type="application/x-dtbncx+xml"/>',
        )
        .replace('<spine>', '<spine toc="ncx">'),
    );
    delete files['OPS/nav.xhtml'];
    files['OPS/nav.ncx'] = strToU8(
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>Chapter one</text></navLabel><content src="c1.xhtml"/></navPoint><navPoint><navLabel><text>Chapter two</text></navLabel><content src="c2.xhtml"/></navPoint></navMap></ncx>',
    );
  }
  return zipSync(files, { level: 0 });
}
