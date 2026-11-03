/** Wire result retained for the original explicitly selected label move. */
export type LabelConsolidationSelection = {
    subjectId: string;
    assignmentId: string;
    revision: number;
};

export type LabelConsolidationAssignmentObservation = {
    id: string;
    revision: number;
    effective: boolean;
};

export type LabelConsolidationReviewItem =
    | {
        selected: LabelConsolidationSelection;
        source: LabelConsolidationAssignmentObservation;
        target: LabelConsolidationAssignmentObservation | null;
        outcome: 'movable';
    }
    | {
        selected: LabelConsolidationSelection;
        source: LabelConsolidationAssignmentObservation;
        target: LabelConsolidationAssignmentObservation;
        outcome: 'already_on_target';
    }
    | {
        selected: LabelConsolidationSelection;
        source: LabelConsolidationAssignmentObservation | null;
        target: LabelConsolidationAssignmentObservation | null;
        outcome: 'capacity_limited';
    }
    | {
        selected: LabelConsolidationSelection;
        source: LabelConsolidationAssignmentObservation | null;
        target: LabelConsolidationAssignmentObservation | null;
        outcome: 'changed';
    }
    | {
        selected: LabelConsolidationSelection;
        source: LabelConsolidationAssignmentObservation | null;
        target: LabelConsolidationAssignmentObservation | null;
        outcome: 'inaccessible';
    }
    | {
        selected: LabelConsolidationSelection;
        source: LabelConsolidationAssignmentObservation | null;
        target: LabelConsolidationAssignmentObservation | null;
        outcome: 'missing';
    };

export type LabelConsolidationResult = {
    confirmationId: string;
    sourceLabelId: string;
    targetLabelId: string;
    status: 'active' | 'completed' | 'cancelled';
    expiresAt: string;
    items: Array<{
        item: number;
        selected?: LabelConsolidationSelection;
        status: 'pending' | 'processing' | 'moved' | 'target_applied_source_retained' | 'capacity_limited' | 'changed' | 'inaccessible';
        targetAssignment?: {
            id: string;
            revision: number;
        };
        targetUnchanged?: boolean;
        sourceUnassignRevision?: number;
    }>;
};
