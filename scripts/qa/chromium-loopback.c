#define _GNU_SOURCE
#include <dlfcn.h>
#include <linux/netlink.h>
#include <sys/socket.h>

/* Chromium's AddressTrackerLinux binds NETLINK_ROUTE multicast groups to watch
 * host interfaces. QA uses loopback; Docker bridge changes do not change any of
 * its destinations. Keep the initial unicast address dump, but subscribe to no
 * interface events. HTTP, DNS, WebSockets and browser offline emulation stay real.
 * https://chromium.googlesource.com/chromium/src/+/main/net/base/address_tracker_linux.cc
 */
int bind(int fd, const struct sockaddr *address, socklen_t length) {
  int (*real_bind)(int, const struct sockaddr *, socklen_t) = dlsym(RTLD_NEXT, "bind");
  if (address && address->sa_family == AF_NETLINK && length >= sizeof(struct sockaddr_nl)) {
    int protocol = -1;
    socklen_t size = sizeof(protocol);
    if (getsockopt(fd, SOL_SOCKET, SO_PROTOCOL, &protocol, &size) == 0 && protocol == NETLINK_ROUTE) {
      struct sockaddr_nl snapshot = *(const struct sockaddr_nl *)address;
      snapshot.nl_groups = 0;
      return real_bind(fd, (const struct sockaddr *)&snapshot, length);
    }
  }
  return real_bind(fd, address, length);
}
