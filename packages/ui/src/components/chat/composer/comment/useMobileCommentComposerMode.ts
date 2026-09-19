/**
 * Owns ChatInput's comment subscription, scope checks, and attach/cancel focus
 * handoff. Callbacks capture the rendered generation; ChatInput keys the shell
 * by it. A quote stays in its captured scope or is dropped, never re-targeted.
 */

import React from 'react';
import { flushSync } from 'react-dom';

import type { MobileComposerShell } from '../state/useMobileComposerShell';
import { useMobileCommentComposerController, useMobileCommentDraft } from './MobileCommentComposerContext';
import type { MobileCommentComposerHandlers } from './MobileCommentComposer';
import {
    applyMobileCommentAttach,
    isSameMobileCommentScope,
    type MobileCommentAttachPlan,
    type MobileCommentScope,
} from './mobileCommentDraft';

export interface MobileCommentModeOptions {
    isMobile: boolean;
    runtimeKey: string;
    /** Session the composer's inline drafts target ('' when there is none). */
    directory: string | null;
    sessionKey: string | null;
    mobileShell: MobileComposerShell;
}

export interface MobileCommentMode {
    active: boolean;
    draft: ReturnType<typeof useMobileCommentDraft>;
    /** Wiring for the comment shell; callbacks are bound to the rendered open. */
    handlers: MobileCommentComposerHandlers;
    /** Attach whatever comment is open right now (form submit path). */
    submit(): void;
}

export function useMobileCommentComposerMode(options: MobileCommentModeOptions): MobileCommentMode {
    const { isMobile, runtimeKey, directory, sessionKey, mobileShell } = options;
    const controller = useMobileCommentComposerController();
    const draft = useMobileCommentDraft(controller);
    const active = isMobile && draft.status === 'open';

    const scope = React.useMemo<MobileCommentScope | null>(
        () => (!runtimeKey || !directory || !sessionKey
            ? null
            : { runtimeKey, directory, sessionKey }),
        [directory, runtimeKey, sessionKey],
    );
    // Latest scope for the synchronous boundary check in attach; the effect
    // below is the passive close for scope switches that happen on their own.
    const scopeRef = React.useRef<MobileCommentScope | null>(scope);
    scopeRef.current = scope;

    React.useEffect(() => {
        if (draft.status !== 'open') return;
        if (!scope || !isSameMobileCommentScope(scope, draft.scope)) {
            controller?.cancel();
        }
    }, [controller, draft, scope]);

    // Entering comment mode unmounts the wrapper-level dictation engine (the
    // shell mounts its own, comment-scoped one); a stale active flag from it
    // must not hold the shell expanded for the comment's lifetime.
    const prevActiveRef = React.useRef(false);
    React.useEffect(() => {
        if (active && !prevActiveRef.current && mobileShell.dictationActive) {
            mobileShell.onDictationActiveChange(false);
        }
        prevActiveRef.current = active;
    }, [active, mobileShell]);

    // Attach inside the tap: expand() flushes the shell swap and focuses the
    // restored composer in the same call stack, as iOS requires for the soft
    // keyboard. A stale or scope-mismatched open restores nothing.
    const attachPlan = React.useCallback((plan: MobileCommentAttachPlan | null) => {
        if (!plan) return;
        if (!applyMobileCommentAttach(plan)) controller?.cancel();
        mobileShell.expand();
    }, [controller, mobileShell]);

    const attach = React.useCallback((generation: number, text?: string) => {
        if (!controller) return;
        flushSync(() => {
            const open = controller.getState();
            if (open.status !== 'open' || open.generation !== generation) return;
            const current = scopeRef.current;
            if (!current || !isSameMobileCommentScope(current, open.scope)) {
                controller.cancel();
                return;
            }
            if (text === undefined) {
                attachPlan(controller.attach(generation));
            } else {
                attachPlan(controller.insertAndAttach(text, generation));
            }
        });
    }, [attachPlan, controller]);

    const cancel = React.useCallback((generation: number) => {
        if (!controller) return;
        let closed = false;
        flushSync(() => {
            closed = controller.cancel(generation);
        });
        if (closed) mobileShell.expand();
    }, [controller, mobileShell]);

    const submit = React.useCallback(() => {
        if (!controller) return;
        const open = controller.getState();
        if (open.status === 'open') attach(open.generation);
    }, [attach, controller]);

    const handlers = React.useMemo<MobileCommentComposerHandlers>(() => {
        if (draft.status !== 'open') {
            const noop = () => undefined;
            return {
                onTextChange: noop,
                onCancel: noop,
                onAttach: noop,
                onDictationInsert: noop,
                onDictationInsertAndSend: noop,
                onEditorFocus: noop,
                onEditorBlur: noop,
                onDictationActiveChange: noop,
            };
        }
        const generation = draft.generation;
        return {
            onTextChange: (text) => controller?.setText(text, generation),
            onCancel: () => cancel(generation),
            onAttach: () => attach(generation),
            onDictationInsert: (text) => controller?.insertText(text, generation),
            onDictationInsertAndSend: (text) => attach(generation, text),
            onEditorFocus: mobileShell.onEditorFocus,
            onEditorBlur: mobileShell.onEditorBlur,
            onDictationActiveChange: mobileShell.onDictationActiveChange,
        };
    }, [attach, cancel, controller, draft, mobileShell]);

    return { active, draft, handlers, submit };
}
