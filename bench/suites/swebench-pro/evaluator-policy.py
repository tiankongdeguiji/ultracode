"""Translate the frozen benchmark policy into Docker SDK run options."""


def docker_run_options(document):
    if document.get("schemaVersion") != 2:
        raise ValueError("benchmark evaluator policy schema is unsupported")
    policy = document.get("containerPolicy")
    if not isinstance(policy, dict):
        raise ValueError("benchmark evaluator container policy is missing")
    expected = {
        "pidsLimit",
        "securityOpt",
        "capDrop",
        "capAdd",
        "nanoCpus",
        "memoryBytes",
    }
    if set(policy) != expected:
        raise ValueError("benchmark evaluator container policy fields are not exact")
    if not isinstance(policy["pidsLimit"], int) or policy["pidsLimit"] <= 0:
        raise ValueError("benchmark evaluator pids limit is invalid")
    if policy["securityOpt"] != ["no-new-privileges"]:
        raise ValueError("benchmark evaluator no-new-privileges policy is invalid")
    if policy["capDrop"] != ["ALL"] or policy["capAdd"] != []:
        raise ValueError("benchmark evaluator capability policy is invalid")
    if not isinstance(policy["nanoCpus"], int) or policy["nanoCpus"] <= 0:
        raise ValueError("benchmark evaluator CPU limit is invalid")
    if not isinstance(policy["memoryBytes"], int) or policy["memoryBytes"] <= 0:
        raise ValueError("benchmark evaluator memory limit is invalid")
    return {
        "pids_limit": policy["pidsLimit"],
        "security_opt": policy["securityOpt"],
        "cap_drop": policy["capDrop"],
        "cap_add": policy["capAdd"],
        "nano_cpus": policy["nanoCpus"],
        "mem_limit": policy["memoryBytes"],
    }
