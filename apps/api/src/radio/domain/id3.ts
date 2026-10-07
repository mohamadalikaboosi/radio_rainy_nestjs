/**
 * Removes a leading ID3v2 tag. Tags in the middle of a concatenated radio stream confuse some players,
 * and cover art can make them large. `onTag` learns the size of the removed tag (bytes of the file that are not audio).
 */
export async function* stripId3v2(source: AsyncIterable<Uint8Array>, onTag?: (bytes: number) => void): AsyncGenerator<Uint8Array> {
  let head = Buffer.alloc(0);
  let skip = -1; // -1: undecided, >=0: bytes still to skip, -2: passthrough
  for await (const chunk of source) {
    if (skip === -2) {
      yield chunk;
      continue;
    }
    let data = Buffer.from(chunk);
    if (skip === -1) {
      head = Buffer.concat([head, data]);
      if (head.length < 10) continue;
      if (head.subarray(0, 3).toString('latin1') === 'ID3') {
        const footer = ((head[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
        const size = ((head[6] ?? 0) << 21) | ((head[7] ?? 0) << 14) | ((head[8] ?? 0) << 7) | (head[9] ?? 0);
        skip = 10 + size + footer;
        onTag?.(skip);
      } else {
        skip = 0;
      }
      data = head;
      head = Buffer.alloc(0);
    }
    if (skip > 0) {
      const drop = Math.min(skip, data.length);
      skip -= drop;
      data = data.subarray(drop);
    }
    if (skip === 0) {
      skip = -2;
      if (data.length > 0) yield data;
    }
  }
  if (head.length > 0) yield head; // very short input
}
