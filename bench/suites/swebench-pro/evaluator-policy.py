"""Validate and translate one host-bound evaluator policy into Docker SDK options."""

import hashlib
import hmac
import json
import re


CANONICAL_CONTAINER_POLICY_SHA256 = (
    "7eb4bcc8ae3ccfec738390ceb2fe97076abc3a6b12a4df2342aaa8333e0b8c7d"
)
TOP_LEVEL_FIELDS = {
    "schemaVersion",
    "kind",
    "evaluatorRepository",
    "evaluatorRevision",
    "strictBooleanVerdicts",
    "emptyPredictions",
    "containerPolicySha256",
    "containerPolicy",
}
CONTAINER_POLICY_FIELDS = {
    "pidsLimit",
    "securityOpt",
    "capDrop",
    "capAdd",
    "nanoCpus",
    "memoryBytes",
}


def _canonical_sha256(document):
    try:
        payload = json.dumps(
            document,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError("benchmark evaluator policy is not canonical JSON") from error
    return hashlib.sha256(payload).hexdigest()


def _positive_integer(value, field):
    if type(value) is not int or value <= 0:
        raise ValueError(f"benchmark evaluator {field} is invalid")


def docker_run_options(document, expected_policy_sha256):
    if not isinstance(document, dict) or set(document) != TOP_LEVEL_FIELDS:
        raise ValueError("benchmark evaluator policy fields are not exact")
    if type(document["schemaVersion"]) is not int or document["schemaVersion"] != 2:
        raise ValueError("benchmark evaluator policy schema is unsupported")
    if document["kind"] != "ultracode-swebench-pro-evaluator-policy":
        raise ValueError("benchmark evaluator policy kind is invalid")
    if not isinstance(document["evaluatorRepository"], str) or not document["evaluatorRepository"]:
        raise ValueError("benchmark evaluator repository is invalid")
    revision = document["evaluatorRevision"]
    if not isinstance(revision, str) or re.fullmatch(r"[a-f0-9]{40}", revision) is None:
        raise ValueError("benchmark evaluator revision is invalid")
    if document["strictBooleanVerdicts"] is not True:
        raise ValueError("benchmark evaluator boolean verdict policy is invalid")
    if document["emptyPredictions"] != "unverified-no-native-output":
        raise ValueError("benchmark evaluator empty prediction policy is invalid")
    if document["containerPolicySha256"] != CANONICAL_CONTAINER_POLICY_SHA256:
        raise ValueError("benchmark evaluator static container policy hash is invalid")
    if not isinstance(expected_policy_sha256, str) or re.fullmatch(
        r"[a-f0-9]{64}", expected_policy_sha256
    ) is None:
        raise ValueError("benchmark evaluator expected policy hash is invalid")
    if not hmac.compare_digest(_canonical_sha256(document), expected_policy_sha256):
        raise ValueError("benchmark evaluator policy does not match its trusted host binding")

    policy = document["containerPolicy"]
    if not isinstance(policy, dict) or set(policy) != CONTAINER_POLICY_FIELDS:
        raise ValueError("benchmark evaluator container policy fields are not exact")
    if type(policy["pidsLimit"]) is not int or policy["pidsLimit"] != 1024:
        raise ValueError("benchmark evaluator pids limit is invalid")
    if policy["securityOpt"] != ["no-new-privileges"]:
        raise ValueError("benchmark evaluator no-new-privileges policy is invalid")
    if policy["capDrop"] != ["ALL"] or policy["capAdd"] != []:
        raise ValueError("benchmark evaluator capability policy is invalid")
    _positive_integer(policy["nanoCpus"], "CPU limit")
    _positive_integer(policy["memoryBytes"], "memory limit")
    return {
        "pids_limit": policy["pidsLimit"],
        "security_opt": policy["securityOpt"],
        "cap_drop": policy["capDrop"],
        "cap_add": policy["capAdd"],
        "nano_cpus": policy["nanoCpus"],
        "mem_limit": policy["memoryBytes"],
    }
