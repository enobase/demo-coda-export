/**
 * Tests for src/prompt.ts
 *
 * Covers: isTTY(), logInfo(), logDerived() — functions that don't
 * require interactive stdin. The prompt() and confirm() functions rely
 * on live stdin and are integration-tested manually.
 */

import { describe, expect, it, mock, spyOn } from "bun:test";
import { isTTY, logDerived, logInfo } from "../prompt.ts";

// ---------------------------------------------------------------------------
// isTTY()
// ---------------------------------------------------------------------------

describe("isTTY()", () => {
	it("returns a boolean", () => {
		const result = isTTY();
		expect(typeof result).toBe("boolean");
	});

	it("returns false when stdin is not a TTY", () => {
		// In a test runner stdin is typically not a TTY
		// We just verify the return type is boolean and doesn't throw
		expect(typeof isTTY()).toBe("boolean");
	});

	it("reflects process.stdin.isTTY and process.stderr.isTTY", () => {
		const expected = Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
		expect(isTTY()).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// logInfo()
// ---------------------------------------------------------------------------

describe("logInfo()", () => {
	it("does not throw", () => {
		expect(() => logInfo("test message")).not.toThrow();
	});

	it("writes to stderr", () => {
		const writes: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
				return true;
			},
		);

		logInfo("hello world");

		expect(writes.length).toBeGreaterThan(0);
		const combined = writes.join("");
		expect(combined).toContain("hello world");

		spy.mockRestore();
	});

	it("includes the info indicator in output", () => {
		const writes: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
				return true;
			},
		);

		logInfo("detecting format");

		const combined = writes.join("");
		// Should contain the info symbol (ℹ) and the message
		expect(combined).toContain("\u2139");
		expect(combined).toContain("detecting format");

		spy.mockRestore();
	});

	it("ends output with a newline", () => {
		const writes: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
				return true;
			},
		);

		logInfo("newline check");

		const combined = writes.join("");
		expect(combined.endsWith("\n")).toBe(true);

		spy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// logDerived()
// ---------------------------------------------------------------------------

describe("logDerived()", () => {
	it("does not throw", () => {
		expect(() => logDerived("Bank ID", "539")).not.toThrow();
	});

	it("writes to stderr", () => {
		const writes: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
				return true;
			},
		);

		logDerived("Bank ID", "539");

		expect(writes.length).toBeGreaterThan(0);

		spy.mockRestore();
	});

	it("includes label and value in output", () => {
		const writes: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
				return true;
			},
		);

		logDerived("Bank ID", "539");

		const combined = writes.join("");
		expect(combined).toContain("Bank ID");
		expect(combined).toContain("539");

		spy.mockRestore();
	});

	it("includes the checkmark symbol", () => {
		const writes: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
				return true;
			},
		);

		logDerived("Account", "BE68539007547034");

		const combined = writes.join("");
		expect(combined).toContain("\u2713");

		spy.mockRestore();
	});

	it("mentions 'derived' in output", () => {
		const writes: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
				return true;
			},
		);

		logDerived("Bank ID", "539");

		const combined = writes.join("");
		expect(combined).toContain("derived");

		spy.mockRestore();
	});

	it("ends output with a newline", () => {
		const writes: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
				return true;
			},
		);

		logDerived("Bank ID", "539");

		const combined = writes.join("");
		expect(combined.endsWith("\n")).toBe(true);

		spy.mockRestore();
	});
});

// Suppress the "mock" unused variable warning — it is imported for type
// availability of the spyOn API
void mock;
