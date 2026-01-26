import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Message, Provider } from "../../src/providers/types.js";
import { WhatsAppProvider, type WhatsAppProviderConfig } from "../../src/providers/whatsapp.js";

describe("WhatsAppProvider", () => {
	test("implements Provider interface", () => {
		const config: WhatsAppProviderConfig = {
			authDir: "/tmp/pion-test-wa-auth",
		};
		const provider = new WhatsAppProvider(config);

		// Check Provider interface
		expect(provider.type).toBe("whatsapp");
		expect(typeof provider.start).toBe("function");
		expect(typeof provider.stop).toBe("function");
		expect(typeof provider.send).toBe("function");
		expect(typeof provider.onMessage).toBe("function");
		expect(typeof provider.isConnected).toBe("function");
	});

	test("has correct type property", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/pion-test-wa-auth",
		});
		expect(provider.type).toBe("whatsapp");
	});

	test("isConnected returns false before start", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/pion-test-wa-auth",
		});
		expect(provider.isConnected()).toBe(false);
	});
});

describe("WhatsAppProvider message normalization", () => {
	test("normalizes text message from baileys format", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/pion-test-wa-auth",
			allowDMs: ["+1234567890"],
		});

		// Simulate baileys message format
		const baileysMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net",
				fromMe: false,
				id: "ABC123",
			},
			pushName: "John Doe",
			message: {
				conversation: "Hello world",
			},
			messageTimestamp: 1706400000,
		};

		const normalized = provider.normalizeMessage(baileysMessage);

		expect(normalized).not.toBeNull();
		expect(normalized?.id).toBe("ABC123");
		expect(normalized?.chatId).toBe("1234567890@s.whatsapp.net");
		expect(normalized?.senderId).toBe("1234567890@s.whatsapp.net");
		expect(normalized?.senderName).toBe("John Doe");
		expect(normalized?.text).toBe("Hello world");
		expect(normalized?.isGroup).toBe(false);
		expect(normalized?.provider).toBe("whatsapp");
	});

	test("normalizes extended text message", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/pion-test-wa-auth",
			allowDMs: ["+1234567890"],
		});

		const baileysMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net",
				fromMe: false,
				id: "ABC123",
			},
			pushName: "Jane",
			message: {
				extendedTextMessage: {
					text: "Hello with extended text",
				},
			},
			messageTimestamp: 1706400000,
		};

		const normalized = provider.normalizeMessage(baileysMessage);

		expect(normalized?.text).toBe("Hello with extended text");
	});

	test("detects group messages by JID suffix", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/pion-test-wa-auth",
			allowGroups: ["123456789012345678@g.us"],
		});

		const groupMessage = {
			key: {
				remoteJid: "123456789012345678@g.us", // Group JID ends with @g.us
				fromMe: false,
				id: "ABC123",
				participant: "1234567890@s.whatsapp.net", // Sender in group
			},
			pushName: "GroupMember",
			message: {
				conversation: "Hello group",
			},
			messageTimestamp: 1706400000,
		};

		const normalized = provider.normalizeMessage(groupMessage);

		expect(normalized?.isGroup).toBe(true);
		expect(normalized?.chatId).toBe("123456789012345678@g.us");
		expect(normalized?.senderId).toBe("1234567890@s.whatsapp.net");
	});

	test("skips messages from self", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/pion-test-wa-auth",
		});

		const selfMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net",
				fromMe: true, // From self
				id: "ABC123",
			},
			message: {
				conversation: "My own message",
			},
			messageTimestamp: 1706400000,
		};

		const normalized = provider.normalizeMessage(selfMessage);

		expect(normalized).toBeNull();
	});

	test("skips messages without text content", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/pion-test-wa-auth",
		});

		// Sticker message (no text)
		const stickerMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net",
				fromMe: false,
				id: "ABC123",
			},
			message: {
				stickerMessage: {
					url: "https://...",
				},
			},
			messageTimestamp: 1706400000,
		};

		const normalized = provider.normalizeMessage(stickerMessage);

		expect(normalized).toBeNull();
	});

	test("extracts caption from image message", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/pion-test-wa-auth",
			allowDMs: ["+1234567890"],
		});

		const imageMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net",
				fromMe: false,
				id: "ABC123",
			},
			pushName: "Photographer",
			message: {
				imageMessage: {
					caption: "Check out this photo!",
					url: "https://...",
				},
			},
			messageTimestamp: 1706400000,
		};

		const normalized = provider.normalizeMessage(imageMessage);

		expect(normalized?.text).toBe("Check out this photo!");
	});

	test("skips status updates", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/pion-test-wa-auth",
		});

		const statusMessage = {
			key: {
				remoteJid: "status@broadcast", // Status broadcast
				fromMe: false,
				id: "ABC123",
			},
			message: {
				conversation: "Status update",
			},
			messageTimestamp: 1706400000,
		};

		const normalized = provider.normalizeMessage(statusMessage);

		expect(normalized).toBeNull();
	});
});

describe("WhatsAppProvider auth directory", () => {
	const testAuthDir = "/tmp/pion-test-wa-auth-dir";

	beforeEach(() => {
		rmSync(testAuthDir, { recursive: true, force: true });
	});

	afterEach(() => {
		rmSync(testAuthDir, { recursive: true, force: true });
	});

	test("creates auth directory on start if missing", async () => {
		const provider = new WhatsAppProvider({
			authDir: testAuthDir,
		});

		// Don't actually connect, just check directory creation
		expect(existsSync(testAuthDir)).toBe(false);

		// The directory should be created when we access ensureAuthDir
		provider.ensureAuthDir();

		expect(existsSync(testAuthDir)).toBe(true);
	});
});

describe("WhatsAppProvider allowlist filtering", () => {
	test("blocks all DMs when allowDMs is empty", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/test",
			allowDMs: [],
		});

		const dmMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net",
				fromMe: false,
				id: "ABC123",
			},
			pushName: "Someone",
			message: { conversation: "Hello" },
			messageTimestamp: 1706400000,
		};

		expect(provider.normalizeMessage(dmMessage)).toBeNull();
	});

	test("blocks DMs not in allowDMs list", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/test",
			allowDMs: ["+905551234567"],
		});

		const dmMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net", // different number
				fromMe: false,
				id: "ABC123",
			},
			pushName: "Stranger",
			message: { conversation: "Hello" },
			messageTimestamp: 1706400000,
		};

		expect(provider.normalizeMessage(dmMessage)).toBeNull();
	});

	test("allows DMs from numbers in allowDMs list", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/test",
			allowDMs: ["+1234567890"],
		});

		const dmMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net",
				fromMe: false,
				id: "ABC123",
			},
			pushName: "Friend",
			message: { conversation: "Hello" },
			messageTimestamp: 1706400000,
		};

		const normalized = provider.normalizeMessage(dmMessage);
		expect(normalized).not.toBeNull();
		expect(normalized?.text).toBe("Hello");
	});

	test("allows DMs with various phone formats in allowDMs", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/test",
			allowDMs: ["1234567890"], // without +
		});

		const dmMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net",
				fromMe: false,
				id: "ABC123",
			},
			pushName: "Friend",
			message: { conversation: "Hello" },
			messageTimestamp: 1706400000,
		};

		expect(provider.normalizeMessage(dmMessage)).not.toBeNull();
	});

	test("blocks all groups when allowGroups is empty", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/test",
			allowGroups: [],
		});

		const groupMessage = {
			key: {
				remoteJid: "120363403098358590@g.us",
				fromMe: false,
				id: "ABC123",
				participant: "1234567890@s.whatsapp.net",
			},
			pushName: "Member",
			message: { conversation: "Hello group" },
			messageTimestamp: 1706400000,
		};

		expect(provider.normalizeMessage(groupMessage)).toBeNull();
	});

	test("blocks groups not in allowGroups list", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/test",
			allowGroups: ["111111111111@g.us"],
		});

		const groupMessage = {
			key: {
				remoteJid: "120363403098358590@g.us", // different group
				fromMe: false,
				id: "ABC123",
				participant: "1234567890@s.whatsapp.net",
			},
			pushName: "Member",
			message: { conversation: "Hello group" },
			messageTimestamp: 1706400000,
		};

		expect(provider.normalizeMessage(groupMessage)).toBeNull();
	});

	test("allows groups in allowGroups list", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/test",
			allowGroups: ["120363403098358590@g.us"],
		});

		const groupMessage = {
			key: {
				remoteJid: "120363403098358590@g.us",
				fromMe: false,
				id: "ABC123",
				participant: "1234567890@s.whatsapp.net",
			},
			pushName: "Member",
			message: { conversation: "Hello group" },
			messageTimestamp: 1706400000,
		};

		const normalized = provider.normalizeMessage(groupMessage);
		expect(normalized).not.toBeNull();
		expect(normalized?.text).toBe("Hello group");
	});

	test("blocks all when no allowlists configured", () => {
		const provider = new WhatsAppProvider({
			authDir: "/tmp/test",
			// no allowDMs, no allowGroups
		});

		const dmMessage = {
			key: {
				remoteJid: "1234567890@s.whatsapp.net",
				fromMe: false,
				id: "ABC123",
			},
			message: { conversation: "Hello" },
			messageTimestamp: 1706400000,
		};

		const groupMessage = {
			key: {
				remoteJid: "120363403098358590@g.us",
				fromMe: false,
				id: "ABC123",
				participant: "1234567890@s.whatsapp.net",
			},
			message: { conversation: "Hello" },
			messageTimestamp: 1706400000,
		};

		expect(provider.normalizeMessage(dmMessage)).toBeNull();
		expect(provider.normalizeMessage(groupMessage)).toBeNull();
	});
});
