/** The acyclic capability seam shared by ordinary member planning and durable preparation. */

export type NativeOwnerFilterCapability<
  Dependencies,
  Actor,
  Admission,
  Binding,
  Source,
  Work,
  Closure,
  Match,
  Attempt,
  PagePlan,
  Ceilings,
  Observation,
  Client,
  NativeBinding,
> = Readonly<{
  bind(
    dependencies: Dependencies,
    actor: Actor,
    collectionId: string,
    admission: Admission,
    deadline: number,
    attempt?: Attempt,
    pagePlan?: PagePlan,
    ceilings?: Ceilings,
  ): Promise<Readonly<{ status: 'unavailable' } | { status: 'bound'; binding: Binding }>>;
  readClosure(
    binding: Binding,
    source: Source,
    subjectId: string,
    work: Work,
    deferDisclosure?: boolean,
  ): Promise<Readonly<{ status: 'unavailable' } | { status: 'complete'; closure: Closure }>>;
  evaluate(client: Client, admission: Admission, closure: Closure, work: Work): Promise<Match>;
  release(binding: Binding): void;
  binding(binding: Binding): NativeBinding | undefined;
  pagePlan(binding: Binding): PagePlan | undefined;
  withSource<T>(binding: Binding, work: Work, body: () => Promise<T>): Promise<T>;
  sameSource(left: Observation, right: Observation): boolean;
  revalidateDisclosure(binding: Binding, work: Work): Promise<void>;
  retainPopulation(binding: Binding, work: Work): Promise<void>;
}>;

export type MembersPreparationReservationCapability<Dependencies, Actor, Definition, Options, Result> = Readonly<{
  reserve(
    dependencies: Dependencies,
    actor: Actor,
    collectionId: string,
    definitions: readonly Definition[],
    options: Options,
  ): Promise<Result>;
}>;

/** Application assembly never discovers either dependency from a process-global registry. */
export type MembersPreparationApplicationAdapters<
  Native,
  Reservation,
  PreparationDependencies,
  PlanDependencies,
  ReaderDependencies,
  Preparation,
  Plan,
  Reader,
> = Readonly<{
  native: Native;
  reservation: Reservation;
  createPreparation(dependencies: PreparationDependencies, native: Native, reservation: Reservation): Preparation;
  createPlan(dependencies: PlanDependencies, native: Native, reservation: Reservation): Plan;
  createReader(dependencies: ReaderDependencies, native: Native, reservation: Reservation): Reader;
}>;
