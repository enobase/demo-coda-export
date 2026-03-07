/**
 * demo-coda-export — Library entry point
 *
 * Re-exports the full public API for programmatic use.
 *
 * Usage:
 *   import { parseTransactions, mapToCoda, serializeCoda, validate } from "./src/index.ts"
 *   import type { CodaConfig, BankTransaction, InputParser } from "./src/index.ts"
 */

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

export { encodeLatin1, toLatin1Safe } from "./encoding.ts";
export type { CodaConfig } from "./mapper.ts";
export {
	buildTransactionCode,
	detectOgm,
	formatOgm,
	mapToCoda,
	splitCommunication,
	toMilliCents,
	toSignCode,
	validateConfig,
	validateOgmCheckDigit,
} from "./mapper.ts";
export type { SerializeOptions } from "./serializer.ts";
export { serializeCoda } from "./serializer.ts";
export type { ValidationError, ValidationResult } from "./validator.ts";
export { validate } from "./validator.ts";

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export { detectFormat, parseTransactions } from "./parsers/index.ts";
export type { BankTransaction, InputFormat, InputParser } from "./parsers/types.ts";

// ---------------------------------------------------------------------------
// CODA types (for advanced users building custom mappers or serializers)
// ---------------------------------------------------------------------------

export type {
	AccountInfo,
	AccountStructure,
	CodaRecord,
	CodaStatement,
	CommunicationType,
	ContinuationCode,
	Record0Header,
	Record1OldBalance,
	Record4FreeMessage,
	Record8NewBalance,
	Record9Trailer,
	Record21Movement,
	Record22MovementContinuation,
	Record23MovementEnd,
	Record31Information,
	Record32InformationContinuation,
	Record33InformationEnd,
	SignCode,
	TransactionCode,
	VersionCode,
} from "./types.ts";
