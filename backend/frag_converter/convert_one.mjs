// Convierte un único IFC a Fragments (.frag). Invocado como subproceso desde
// FastAPI (services/frag_cache.py). Basado en SPIKE_VISOR/scripts/convert.mjs,
// ya validado contra la federación ADIF real (21 archivos, 401MB -> 81MB, 162s).
//
// Uso: node convert_one.mjs <entrada.ifc> <salida.frag>
// Salida: una línea JSON por stdout: {ok, ifcBytes, fragBytes, secs} o {ok:false, error}.
import { IfcImporter } from "@thatopen/fragments";
import { readSync } from "node:fs";
import { open, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , SRC, OUT] = process.argv;
if (!SRC || !OUT) {
  console.log(JSON.stringify({ ok: false, error: "uso: convert_one.mjs <in.ifc> <out.frag>" }));
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(__dirname, "node_modules", "web-ifc") + path.sep;

async function main() {
  const { size } = await stat(SRC);
  const serializer = new IfcImporter();
  serializer.wasm = { absolute: true, path: wasmPath };

  const handle = await open(SRC, "r");
  const chunk = new Uint8Array(64 * 1024);
  const t0 = performance.now();
  try {
    const out = await serializer.process({
      readFromCallback: true,
      readCallback: (offset) => {
        const n = readSync(handle.fd, chunk, 0, chunk.length, offset);
        return chunk.slice(0, n);
      },
    });
    await writeFile(OUT, out);
    const secs = (performance.now() - t0) / 1000;
    console.log(JSON.stringify({ ok: true, ifcBytes: size, fragBytes: out.byteLength, secs }));
  } finally {
    await handle.close();
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
});
