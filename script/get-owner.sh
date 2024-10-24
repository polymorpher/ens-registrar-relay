#!/bin/zsh

export $(grep -v '^#' .env.script | xargs)

cast call ${TLD_NW} "owner()(address)" -r ${RPC}