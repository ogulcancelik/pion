declare module "qrcode-terminal" {
	const qrcode: {
		generate(input: string, options?: { small?: boolean }, callback?: () => void): void;
	};

	export default qrcode;
}
