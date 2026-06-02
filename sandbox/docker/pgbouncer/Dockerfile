FROM debian:bookworm-slim

# pgbouncer + psql client (for SHOW DATABASES on admin) + sshd
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        pgbouncer postgresql-client openssh-server sudo passwd && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash ec2-user && \
    echo "ec2-user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ec2-user && \
    chmod 0440 /etc/sudoers.d/ec2-user

RUN mkdir -p /home/ec2-user/.ssh && \
    chmod 700 /home/ec2-user/.ssh && \
    chown ec2-user:ec2-user /home/ec2-user/.ssh && \
    sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    echo "PasswordAuthentication no" >> /etc/ssh/sshd_config && \
    mkdir -p /run/sshd

# Config owned by the postgres user pgbouncer drops to after binding :5432
COPY pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
COPY userlist.txt /etc/pgbouncer/userlist.txt
RUN chown postgres:postgres /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt && \
    chmod 640 /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt && \
    mkdir -p /var/log/pgbouncer /var/run/pgbouncer && \
    chown postgres:postgres /var/log/pgbouncer /var/run/pgbouncer

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22 5432
CMD ["/entrypoint.sh"]
