#!/bin/zsh

export $(grep -v '^#' .env.script | xargs)

cast calldata "initialize(string[],address[],uint256[],address,uint32,uint64)" "${SLDS}" "${OWNERS}" "${DURATIONS}" "${RESOLVER}" 0 18446744073709551615