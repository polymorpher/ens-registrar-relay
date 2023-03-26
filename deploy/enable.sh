#!/bin/sh
sudo cp 1ns-registrar-relay.service /etc/systemd/system/1ns-registrar-relay.service
sudo systemctl enable 1ns-registrar-relay
sudo systemctl start 1ns-registrar-relay
systemctl status 1ns-registrar-relay
