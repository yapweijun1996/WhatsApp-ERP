export type StaffCapability = object;
export type VerifyStaffCapability = (candidate: unknown) => string | undefined;

/**
 * Issues opaque, process-local staff capabilities. Only the authority that
 * created a capability can verify it; request-body labels or predictable
 * strings cannot forge one.
 */
export function createStaffCapabilityAuthority() {
  const issued = new WeakMap<object, string>();
  return {
    issue(subject: string): StaffCapability {
      const capability = Object.freeze(Object.create(null)) as object;
      issued.set(capability, subject);
      return capability;
    },
    verify: ((candidate: unknown) => {
      if ((typeof candidate !== 'object' && typeof candidate !== 'function') || candidate === null) return undefined;
      return issued.get(candidate as object);
    }) satisfies VerifyStaffCapability,
  };
}
