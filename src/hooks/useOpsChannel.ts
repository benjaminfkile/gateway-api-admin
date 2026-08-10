import { useEffect, useRef, useState } from "react";
import { HubConnectionState } from "@microsoft/signalr";
import {
  type ChannelHandler,
  ensureStarted,
  getConnectionState,
  joinChannel,
  leaveChannel,
  onChannelEvent,
  subscribeConnectionState,
} from "../lib/hubClient";

export interface OpsChannel {
  /** Live SignalR connection state for the shared hub connection. */
  connectionState: HubConnectionState;
  /** True only when the hub is fully connected (drives the "live" dot). */
  connected: boolean;
}

/**
 * Subscribe a component to a logical hub channel. Lazily starts the one shared
 * connection, joins the channel on mount, and leaves + unsubscribes on unmount.
 * `onEvent` fires for every event on the channel with the event name and its
 * data payload; the latest callback is used without re-subscribing. The hub is
 * purely additive — callers keep polling as a fallback and use `connected` to
 * show that live updates are flowing.
 */
export function useOpsChannel(channel: string, onEvent: ChannelHandler): OpsChannel {
  const [connectionState, setConnectionState] =
    useState<HubConnectionState>(getConnectionState());

  // Keep the newest handler without tearing down the subscription each render.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let active = true;
    const unsubState = subscribeConnectionState(setConnectionState);
    const unsubEvent = onChannelEvent(channel, (event, data) => {
      handlerRef.current(event, data);
    });

    ensureStarted()
      .then(() => {
        if (!active) return undefined;
        setConnectionState(getConnectionState());
        return joinChannel(channel);
      })
      .catch((err) => {
        // Hub unavailable — polling remains the fallback. Surface it in the
        // console instead of swallowing so a stuck subscription is diagnosable.
        console.warn(`useOpsChannel: could not start/join "${channel}"`, err);
      });

    return () => {
      active = false;
      unsubEvent();
      unsubState();
      // Best-effort leave; ignore if the socket is already gone.
      void leaveChannel(channel).catch((err) => {
        console.warn(`useOpsChannel: could not leave "${channel}"`, err);
      });
    };
  }, [channel]);

  return {
    connectionState,
    connected: connectionState === HubConnectionState.Connected,
  };
}

/** Live fleet updates (service/instance changes) on the "ops:fleet" channel. */
export function useFleetStatus(onEvent: ChannelHandler): OpsChannel {
  return useOpsChannel("ops:fleet", onEvent);
}

/**
 * Live deploy-progress updates on the "ops:deploys" channel, filtered to a
 * single deploy. Pass `null` to stay subscribed (e.g. for the "live" dot)
 * without delivering any events.
 */
export function useDeployProgress(
  deployId: string | null,
  onEvent: ChannelHandler,
): OpsChannel {
  return useOpsChannel("ops:deploys", (event, data) => {
    if (deployId !== null && data.deployId === deployId) onEvent(event, data);
  });
}
