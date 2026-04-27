const CSI_PATTERN = /^\x1b\[([0-9;?]*)([A-Za-z])/;

function applyEraseInLine(buffer: string[], cursor: number, mode: number): { buffer: string[]; cursor: number } {
  if (mode === 1) {
    const nextBuffer = buffer.slice(cursor + 1);
    return { buffer: nextBuffer, cursor: 0 };
  }
  if (mode === 2) {
    return { buffer: [], cursor: 0 };
  }
  return { buffer: buffer.slice(0, cursor), cursor };
}

export function renderTerminalText(raw: string): string {
  const lines: string[] = [];
  let lineBuffer: string[] = [];
  let cursor = 0;
  let index = 0;

  while (index < raw.length) {
    const remaining = raw.slice(index);
    const csiMatch = remaining.match(CSI_PATTERN);
    if (csiMatch) {
      const params = csiMatch[1]
        .split(";")
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value));
      const command = csiMatch[2];
      const amount = params[0] ?? 1;
      if (command === "K") {
        const result = applyEraseInLine(lineBuffer, cursor, params[0] ?? 0);
        lineBuffer = result.buffer;
        cursor = result.cursor;
      } else if (command === "G") {
        cursor = Math.max(0, amount - 1);
      } else if (command === "C") {
        cursor += amount;
      } else if (command === "D") {
        cursor = Math.max(0, cursor - amount);
      }
      index += csiMatch[0].length;
      continue;
    }

    const char = raw[index];
    if (char === "\r") {
      cursor = 0;
      index += 1;
      continue;
    }
    if (char === "\n") {
      lines.push(lineBuffer.join(""));
      lineBuffer = [];
      cursor = 0;
      index += 1;
      continue;
    }
    if (char === "\b") {
      cursor = Math.max(0, cursor - 1);
      index += 1;
      continue;
    }
    if (char === "\x1b") {
      index += 1;
      continue;
    }
    if (char < " " && char !== "\t") {
      index += 1;
      continue;
    }

    while (lineBuffer.length < cursor) {
      lineBuffer.push(" ");
    }
    if (cursor >= lineBuffer.length) {
      lineBuffer.push(char);
    } else {
      lineBuffer[cursor] = char;
    }
    cursor += 1;
    index += 1;
  }

  lines.push(lineBuffer.join(""));
  return lines.join("\n");
}
