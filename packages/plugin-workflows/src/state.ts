// ─── Workflow Instance Types ──────────────────────────────────────────────────

export type WorkflowStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'COMPENSATION_FAILED'

export type StepStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'failed'

export interface StepState {
  status: StepStatus
  jobId?: string
  result?: unknown
  error?: string
}

export interface WorkflowInstance {
  id: string
  definitionName: string
  status: WorkflowStatus
  payload: unknown
  stepStates: Record<string, StepState>
  createdAt: Date
  updatedAt: Date
}

// ─── In-Memory Store ─────────────────────────────────────────────────────────

export class WorkflowStore {
  private instances = new Map<string, WorkflowInstance>()

  create(instance: WorkflowInstance): void {
    this.instances.set(instance.id, instance)
  }

  get(id: string): WorkflowInstance | undefined {
    return this.instances.get(id)
  }

  list(): WorkflowInstance[] {
    return [...this.instances.values()]
  }

  update(id: string, fn: (instance: WorkflowInstance) => void): WorkflowInstance | undefined {
    const instance = this.instances.get(id)
    if (!instance) return undefined
    fn(instance)
    instance.updatedAt = new Date()
    return instance
  }

  delete(id: string): boolean {
    return this.instances.delete(id)
  }

  /** Find workflow instance by a step's jobId */
  findByJobId(jobId: string): WorkflowInstance | undefined {
    for (const instance of this.instances.values()) {
      for (const stepState of Object.values(instance.stepStates)) {
        if (stepState.jobId === jobId) {
          return instance
        }
      }
    }
    return undefined
  }

  /** Find the step name for a given jobId within a workflow instance */
  findStepByJobId(workflowId: string, jobId: string): string | undefined {
    const instance = this.instances.get(workflowId)
    if (!instance) return undefined
    for (const [stepName, stepState] of Object.entries(instance.stepStates)) {
      if (stepState.jobId === jobId) {
        return stepName
      }
    }
    return undefined
  }
}
