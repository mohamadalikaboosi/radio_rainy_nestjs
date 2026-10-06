import { useState } from 'react';
import { useT } from '../i18n';

export const stationUrl = (publicId: string): string => `${window.location.origin}/${publicId}`;

/** The permanent address of one station (/<uuid>): the link an operator or owner shares. It never changes and the page can never play another station. */
export function DirectLink({ publicId }: { publicId: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const url = stationUrl(publicId);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt(t('station.directLink'), url); // clipboard blocked (http, old browser): let them copy by hand
    }
  };
  return (
    <div className="row wrap">
      <small className="muted">{t('station.directLink')}:</small>
      <a href={`/${publicId}`} target="_blank" rel="noreferrer">
        <code>{url}</code>
      </a>
      <button type="button" className="btn btn-small" onClick={() => void copy()}>
        {copied ? t('station.copied') : t('station.copy')}
      </button>
    </div>
  );
}
