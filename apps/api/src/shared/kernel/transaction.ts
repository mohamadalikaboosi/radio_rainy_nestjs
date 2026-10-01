/**
 * An open database transaction, as the application layer sees it: an opaque handle it only passes back to repositories.
 * (Only the persistence adapters look inside and run SQL with it.)
 */
export type TxHandle = object;

/** Runs a use case's repository calls atomically (commit on success, roll back on any error). */
export abstract class TransactionRunner {
  abstract tx<R>(fn: (tx: TxHandle) => Promise<R>): Promise<R>;
}
