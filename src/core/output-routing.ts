export type OutputDeliveryKind = "stream" | "fallback" | "warning" | "error";

export interface OutputDeliveryTarget {
	replyTo?: string;
}

export function getOutputDeliveryTarget(
	_kind: OutputDeliveryKind,
	_incomingMessageId?: string,
): OutputDeliveryTarget {
	return {};
}
