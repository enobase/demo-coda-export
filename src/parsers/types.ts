/**
 * Normalized transaction model shared by all input parsers.
 * Phase 2 of the CODA export pipeline.
 */

export interface BankTransaction {
	/** Settlement / completion date */
	date: Date;
	/** Value date if different from settlement date */
	valueDate?: Date;
	/** Signed amount: negative = debit, positive = credit */
	amount: number;
	/** ISO 4217 currency code, e.g. "EUR" */
	currency: string;
	/** Free-text description of the transaction */
	description: string;
	counterpartyName?: string;
	counterpartyIban?: string;
	counterpartyBic?: string;
	/** Structured reference if available (e.g. Belgian OGM/VCS) */
	reference?: string;
	/** Category label from the source format */
	category?: string;
	/** Running balance after this transaction, if provided by source */
	balance?: number;
	/** Fee amount if reported separately by the source */
	fee?: number;
	/** Original transaction type string from the source */
	rawType?: string;
	source: "revolut-personal" | "revolut-business" | "qonto";
}

export type InputFormat = "revolut-personal" | "revolut-business" | "qonto";

export interface InputParser {
	name: string;
	format: InputFormat;
	/** Return true if the given header line looks like this format */
	detect(headerLine: string): boolean;
	/** Parse the full CSV content and return normalised transactions */
	parse(content: string): BankTransaction[];
}
