import { Unzip, UnzipInflate } from "npm:fflate@0.8.2";

export type CsvRow = Record<string, string>;

/**
 * Descompacta um ZIP da CVM em streaming e entrega cada linha CSV
 * sem guardar o arquivo inteiro em memória.
 */
export async function forEachZipCsvRow(
  resp: Response,
  onRow: (row: CsvRow) => Promise<void> | void,
): Promise<void> {
  if (!resp.body) throw new Error("download da CVM sem corpo");

  const decoder = new TextDecoder("iso-8859-1");

  await new Promise<void>((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);

    let openFiles = 0;
    let pushDone = false;
    let settled = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const maybeDone = () => {
      if (!settled && pushDone && openFiles === 0) {
        settled = true;
        resolve();
      }
    };

    unzip.onfile = (file) => {
      const name = file.name ?? "";
      if (!name.toLowerCase().endsWith(".csv")) return;

      openFiles += 1;
      let leftover = "";
      let header: string[] | null = null;
      let chain = Promise.resolve();

      file.ondata = (err, chunk, final) => {
        chain = chain
          .then(async () => {
            if (err) throw err;
            leftover += decoder.decode(chunk, { stream: !final });
            const parts = leftover.split(/\r?\n/);
            leftover = final ? "" : (parts.pop() ?? "");
            for (const line of parts) {
              if (!line) continue;
              if (!header) {
                header = line.split(";").map((h) => h.trim());
                continue;
              }
              const cols = line.split(";");
              const row: CsvRow = {};
              header.forEach((h, i) => {
                row[h] = cols[i]?.trim() ?? "";
              });
              await onRow(row);
            }
            if (final) {
              openFiles -= 1;
              maybeDone();
            }
          })
          .catch(fail);
      };

      file.start();
    };

    const reader = resp.body!.getReader();
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          unzip.push(new Uint8Array(), true);
          pushDone = true;
          maybeDone();
          break;
        }
        unzip.push(value);
      }
    })().catch(fail);
  });
}
