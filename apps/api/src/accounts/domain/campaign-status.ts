/** Campaign review workflow (an ad row owned by an account). Pure, so every rule is unit-tested. */
export type CampaignStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED';
export type CampaignAction = 'submit' | 'approve' | 'reject' | 'pause' | 'resume' | 'edit-content';

export class InvalidTransitionError extends Error {}

export function transition(current: CampaignStatus, action: CampaignAction, opts: { approvalRequired: boolean; hasAudio: boolean }): CampaignStatus {
  const bad = (why: string): never => {
    throw new InvalidTransitionError(`Cannot ${action} a ${current} campaign${why ? `: ${why}` : ''}`);
  };
  switch (action) {
    case 'submit':
      if (current !== 'DRAFT' && current !== 'REJECTED') return bad('');
      if (!opts.hasAudio) return bad('upload the audio first');
      return opts.approvalRequired ? 'PENDING' : 'APPROVED';
    case 'approve':
      return current === 'PENDING' ? 'APPROVED' : bad('');
    case 'reject':
      return current === 'PENDING' || current === 'APPROVED' || current === 'PAUSED' ? 'REJECTED' : bad('');
    case 'pause':
      return current === 'APPROVED' ? 'PAUSED' : bad('');
    case 'resume':
      return current === 'PAUSED' ? 'APPROVED' : bad('');
    case 'edit-content':
      // Approved content must not change behind the reviewer's back: any edit sends it back to DRAFT for a new review.
      return 'DRAFT';
  }
}
