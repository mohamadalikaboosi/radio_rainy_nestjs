import { ReactNode, useRef, useState } from 'react';
import { errorMessage } from '../hooks';

/** A button that opens the file dialog, hands the chosen file to `onFile` and reports failures inline. */
export function FilePick({ accept, onFile, children, className = 'btn btn-small', disabled }: { accept: string; onFile: (file: File) => Promise<unknown>; children: ReactNode; className?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="action">
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        data-testid="file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          setErr(null);
          onFile(file)
            .catch((error: unknown) => setErr(errorMessage(error)))
            .finally(() => setBusy(false));
        }}
      />
      <button type="button" className={className} disabled={busy || disabled} onClick={() => input.current?.click()}>
        {busy ? '…' : children}
      </button>
      {err && (
        <span className="inline-error" role="alert">
          {err}
        </span>
      )}
    </span>
  );
}
