#!/bin/bash
uid=$(basename $(pwd))

echo
echo "stopping $uid..."
forever stop "$uid"

echo
echo "saving latest logs..."
savestamp=`date "+%Y-%m-%d_%H-%M-%S"`
echo "run.log -> logs/$savestamp.log"
mv run.log logs/$savestamp.log
echo "run.err -> logs/$savestamp.err"
mv run.err logs/$savestamp.err

echo
echo "starting $uid (run.log, run.err)"
forever -l forever.log -a -o run.log -e run.err --uid "$uid" start --max_old_space_size=150 app.js
