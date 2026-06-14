# Third-Party Notices

This project uses third-party WebAssembly codecs bundled into `main.js`.

Because the distributed plugin bundles `imagequant`/libimagequant, which is
licensed under GPL v3 or later, the plugin distribution is licensed as
GPL-3.0-or-later. See `LICENSE`.

Exact license texts copied from the pinned packages are tracked locally:

- `licenses/Apache-2.0.txt` for the `@jsquash/jpeg` and `@jsquash/png`
  JavaScript wrappers.
- `licenses/jpeg-codec.txt` for the bundled libjpeg-turbo codec.
- `licenses/png-codec.txt` for the bundled PNG codec.
- `LICENSE` for `imagequant`/libimagequant and this GPL-3.0-or-later
  distribution.

`npm run test:release` verifies these copies byte-for-byte against the pinned
installed packages and validates the embedded WASM hashes.

## imagequant / libimagequant
- Package: `imagequant`
- Source: https://github.com/valterkraemer/imagequant-wasm
- Upstream codec: https://github.com/ImageOptim/libimagequant
- License: GPL v3

The PNG lossy quantization path uses the `imagequant` WASM binding so the
plugin can preserve the previous pngquant-style quality range and quality-fail
semantics without shipping native binaries.

Full license: https://www.gnu.org/licenses/gpl-3.0.txt

## @jsquash/jpeg / mozjpeg
- Package: `@jsquash/jpeg`
- Pinned version: `1.6.0`
- Source: https://github.com/jamsinclair/jSquash
- Upstream codec: https://github.com/mozilla/mozjpeg
- License: Apache-2.0 for the package wrapper; the bundled libjpeg-turbo codec
  uses IJG, Modified BSD, and zlib terms.

Required attribution: This software is based in part on the work of the
Independent JPEG Group.

Exact texts: `licenses/Apache-2.0.txt` and `licenses/jpeg-codec.txt`.

## @jsquash/png
- Package: `@jsquash/png`
- Pinned version: `3.1.1`
- Source: https://github.com/jamsinclair/jSquash
- License: Apache-2.0 for the package wrapper; BSD-3-Clause for the bundled
  codec.

Exact texts: `licenses/Apache-2.0.txt` and `licenses/png-codec.txt`.

## imagequant / libimagequant integrity

- Package version: `0.1.2`.
- Exact GPL-3.0 text: `LICENSE`.
- Embedded codec hashes: `wasm-hashes.json`.

The release artifact does not include native compressor executables or
`node_modules/pngquant-bin/vendor` / `node_modules/mozjpeg/vendor` binaries.
